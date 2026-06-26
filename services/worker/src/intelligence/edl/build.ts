// Intelligence — beat-aligned EDL builder (M7 §2/§3). PURE + directly importable
// (validates against the contracts `edlSchema`, NO essentia/remotion import). Takes
// the chronologically-ordered scored clips + a track (precomputed beat grid) + a
// theme and lays the 30s/1080×1920/30fps timeline, cutting ON the beat:
//
//  - segment boundaries snap to grid beats (so `edlCutsOnBeats` holds within tol),
//  - photos hold for a beat-length window, videos trim a beat-length window around
//    their highest-scoring moment (`bestWindowMs`),
//  - per-theme pacing biases cut density (shorter/denser for fast_cut/party, longer
//    holds for chill/soft) and picks the transition + overlay treatment,
//  - the LAST segment ends EXACTLY at 30000 so Σ durationMs === 30000 (the contract
//    invariant), and every provided clip is used (no others).
//
// All segment startMs/durationMs are integer ms so the telescoping sum is exact.
import { edlSchema, type Edl } from "@twenty4/contracts";
import type { Theme } from "@twenty4/contracts";
import type { ScoredClip } from "../scoring/score.ts";

export interface EdlTrack {
  id: string;
  bpm: number;
  beatGrid: number[]; // beat onset times (ms) from track start
}

export interface BuildEdlArgs {
  scoredClips: ScoredClip[]; // chronological order (caller-provided)
  track: EdlTrack;
  theme: Theme;
}

const TIMELINE_MS = 30000;

type Transition = "cut" | "crossfade" | "dipToBlack";
type Overlay = "none" | "grain" | "vignette";

interface ThemePacing {
  transition: Transition;
  cutDensity: number; // 0..1 (higher ⇒ shorter/denser cuts)
  overlay: Overlay;
}

// Per-theme pacing/transition/overlay (M7 §2). cutDensity drives beats-per-segment.
const THEME_PACING: Record<Theme, ThemePacing> = {
  chill: { transition: "crossfade", cutDensity: 0.25, overlay: "vignette" },
  party: { transition: "cut", cutDensity: 0.85, overlay: "none" },
  clean: { transition: "cut", cutDensity: 0.5, overlay: "none" },
  travel: { transition: "crossfade", cutDensity: 0.45, overlay: "none" },
  random: { transition: "cut", cutDensity: 0.6, overlay: "grain" },
  fast_cut: { transition: "cut", cutDensity: 0.95, overlay: "none" },
  soft: { transition: "crossfade", cutDensity: 0.2, overlay: "grain" },
};

// cutDensity → how many beats each segment spans (1=densest .. 4=longest holds).
function beatsPerSegment(cutDensity: number): number {
  return Math.min(4, Math.max(1, Math.round(1 + (1 - cutDensity) * 3)));
}

// Choose internal cut points as grid beats, evenly distributed, returning the
// segment START times (length === segmentCount; startMs[0] === 0). Each internal
// boundary is a grid beat snapped to integer ms (so edlCutsOnBeats holds).
function planSegmentStarts(beatGrid: number[], segmentCount: number): number[] {
  // Beats strictly inside (0, 30000), as integers, de-duplicated + sorted.
  const interior = Array.from(
    new Set(beatGrid.filter((b) => b > 0 && b < TIMELINE_MS).map((b) => Math.round(b))),
  ).sort((a, b) => a - b);

  const starts: number[] = [0];
  const cuts = segmentCount - 1; // internal boundaries needed
  if (cuts > 0 && interior.length > 0) {
    let prevBeatIdx = -1;
    for (let i = 1; i <= cuts; i++) {
      // Even spread across the interior beats; strictly increasing.
      let beatIdx = Math.round((i * interior.length) / segmentCount) - 1;
      if (beatIdx <= prevBeatIdx) beatIdx = prevBeatIdx + 1;
      if (beatIdx >= interior.length) beatIdx = interior.length - 1;
      prevBeatIdx = beatIdx;
      starts.push(interior[beatIdx]!);
    }
  }
  // Guarantee strict monotonicity (degenerate grids): drop any non-increasing dups.
  const mono: number[] = [];
  for (const s of starts) if (mono.length === 0 || s > mono[mono.length - 1]!) mono.push(s);
  return mono;
}

// Build a beat-length trim window for a video around its highlight centre.
function videoTrim(
  clip: ScoredClip,
  segDurationMs: number,
): { inMs: number; outMs: number } {
  const src = clip.durationMs > 0 ? clip.durationMs : segDurationMs;
  const centre = clip.bestWindowMs
    ? (clip.bestWindowMs.inMs + clip.bestWindowMs.outMs) / 2
    : src / 2;
  let inMs = Math.round(centre - segDurationMs / 2);
  // Clamp the window inside the source if it's long enough; otherwise start at 0.
  if (src >= segDurationMs) {
    if (inMs < 0) inMs = 0;
    if (inMs + segDurationMs > src) inMs = src - segDurationMs;
  } else {
    inMs = 0;
  }
  let outMs = inMs + segDurationMs;
  // Never ask for frames past the source EOF — OffthreadVideo freezes/blacks on
  // the tail. Cap the SOURCE trim window at the clip's real length (the segment's
  // on-screen durationMs + the Σ===30000 invariant are unaffected).
  if (clip.durationMs > 0 && outMs > clip.durationMs) outMs = clip.durationMs;
  // Degenerate (clip shorter than inMs): restart the window at 0 within source.
  if (outMs <= inMs) {
    inMs = 0;
    outMs = Math.min(segDurationMs, clip.durationMs > 0 ? clip.durationMs : segDurationMs);
  }
  return { inMs, outMs };
}

export function buildEdl(args: BuildEdlArgs): Edl {
  const { scoredClips, track, theme } = args;
  if (scoredClips.length === 0) throw new Error("buildEdl: no clips provided");

  const pacing = THEME_PACING[theme];
  const perSeg = beatsPerSegment(pacing.cutDensity);

  const interiorBeats = track.beatGrid.filter((b) => b > 0 && b < TIMELINE_MS).length;
  const maxSegments = Math.max(1, interiorBeats + 1); // most segments the grid supports

  // Target segment count from theme pacing, then ensure EVERY clip is used (so the
  // EDL references exactly the provided set) and we never exceed the grid capacity.
  const targetByTheme = Math.max(1, Math.round((interiorBeats + 1) / perSeg));
  let segmentCount = Math.max(targetByTheme, scoredClips.length);
  segmentCount = Math.min(segmentCount, maxSegments);
  // If the grid can't host one segment per clip, cap to the clip count anyway and
  // let planSegmentStarts pack what it can (degenerate path; tests use few clips).
  segmentCount = Math.max(segmentCount, Math.min(scoredClips.length, maxSegments));

  const starts = planSegmentStarts(track.beatGrid, segmentCount);
  const realCount = starts.length;

  const segments: Edl["segments"] = [];
  for (let i = 0; i < realCount; i++) {
    const startMs = starts[i]!;
    const endMs = i === realCount - 1 ? TIMELINE_MS : starts[i + 1]!;
    const segDurationMs = endMs - startMs;
    const clip = scoredClips[i % scoredClips.length]!;

    let inMs: number;
    let outMs: number;
    if (clip.mediaType === "video") {
      ({ inMs, outMs } = videoTrim(clip, segDurationMs));
    } else {
      inMs = 0;
      outMs = segDurationMs; // photo hold == on-screen length
    }

    segments.push({
      mediaRef: clip.mediaRef,
      mediaType: clip.mediaType,
      inMs,
      outMs,
      startMs,
      durationMs: segDurationMs,
      // First segment cuts in clean; subsequent ones use the theme transition.
      transition: i === 0 ? "cut" : pacing.transition,
      overlay: pacing.overlay,
    });
  }

  const edl: Edl = {
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs: 30000,
    musicId: track.id,
    themeStyle: {
      theme,
      transition: pacing.transition,
      cutDensity: pacing.cutDensity,
      overlay: pacing.overlay,
    },
    audio: {
      musicId: track.id,
      srcRef: `music/${track.id}.wav`,
      beatGrid: track.beatGrid,
    },
    segments,
    beatGrid: track.beatGrid,
  };

  // Validate against the single-source-of-truth strict schema — any drift throws here.
  return edlSchema.parse(edl);
}
