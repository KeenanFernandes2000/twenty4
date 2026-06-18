/**
 * EDL build (§7.1 step 3-5) — THE CORE of the montage intelligence.
 *
 * Given (a) a pool of validated, SCORED media items, (b) a chosen track's beat
 * grid, and (c) a theme, produce a contracts-valid `Edl`:
 *
 *   - cuts land ON beats (every segment boundary is a beat-grid time);
 *   - faster cutting in high-energy sections (near a `drop` → fewer beats/cut);
 *   - each VIDEO is trimmed to a beat-aligned window around its top-scoring
 *     moment (`bestWindow` from scoring), clamped to the source length;
 *   - PHOTOS are held for ≥ a beat;
 *   - segments are GAPLESS and sum to EXACTLY 30000ms;
 *   - the highest-scoring media is placed first / used preferentially;
 *   - transitions are per-theme; `Random` theme is resolved to a concrete theme
 *     BEFORE emitting (the EDL only ever carries a concrete theme);
 *   - DETERMINISTIC given the same inputs (any "randomness" is seeded by index).
 *
 * The output is parsed through `edlSchema` so an invalid EDL can never escape.
 */
import {
  EDL_DURATION_MS,
  EDL_FPS,
  edlSchema,
  type Edl,
  type EdlSegment,
  type Transition,
  type TransitionType,
  type Overlay,
  type OverlayType,
} from '@twenty4/contracts/edl';
import type { MediaType, Theme } from '@twenty4/contracts/enums';
import { getThemeParams, resolveTheme, type ThemeParams } from '../themes.js';
import type { ClipScore } from '../scoring/score.js';

/** One beat = the frame quantum; cuts snap to beats which we snap to frames. */
const FRAME_MS = 1000 / EDL_FPS;

export interface BuildTrack {
  /** Bundled / analyzed track id (EDL `audio.musicId`). */
  musicId: string;
  /** BPM (exact for synth tracks, detected for real audio). */
  bpm: number;
  /** Beat onset times (ms) over the whole track (>= 30s of grid). */
  beatGridMs: number[];
  /** Optional higher-energy markers biasing faster cuts near them. */
  dropsMs?: number[];
  /** Audio offset into the track to start from (ms). Default 0. */
  startMs?: number;
}

export interface BuildItem {
  mediaRef: string;
  mediaType: MediaType;
  /** Source clip length (ms); required for video, ignored for photos. */
  sourceDurationMs?: number;
  /** The clip's score (from `scoreMedia`) — drives selection + ordering + trim. */
  score: ClipScore;
}

export interface BuildEdlInput {
  items: BuildItem[];
  track: BuildTrack;
  theme: Theme;
  /** Audio master volume 0..1 (default 0.9). */
  volume?: number;
}

/* -------------------------------------------------------------------------- */
/*  beat-grid helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Snap a ms time to the nearest 30fps frame boundary (renderer quantum). */
function snapToFrame(ms: number): number {
  return Math.round(Math.round(ms / FRAME_MS) * FRAME_MS);
}

/**
 * Build the in-window beat list: every beat time in [0, 30000], frame-snapped,
 * de-duplicated, with an explicit closing edge at exactly 30000. This is the
 * grid every cut aligns to AND what we emit as `beatGrid.beatsMs`.
 */
function windowBeats(beatGridMs: number[]): number[] {
  const inWin = beatGridMs
    .filter((b) => b >= 0 && b <= EDL_DURATION_MS)
    .map(snapToFrame)
    .filter((b) => b >= 0 && b <= EDL_DURATION_MS);
  const set = new Set<number>(inWin);
  set.add(0);
  set.add(EDL_DURATION_MS); // guarantee a final boundary at exactly 30s
  return [...set].sort((a, b) => a - b);
}

/** Is `beatMs` within `windowMs` of any drop marker? (→ bias faster cuts) */
function nearDrop(beatMs: number, dropsMs: number[] | undefined, windowMs: number): boolean {
  if (!dropsMs?.length) return false;
  for (const d of dropsMs) if (Math.abs(d - beatMs) <= windowMs) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/*  transition / overlay per theme                                              */
/* -------------------------------------------------------------------------- */

function mkTransition(
  type: TransitionType,
  params: ThemeParams,
  beatMs: number,
): Transition {
  if (type === 'cut') return { type: 'cut', durationMs: 0 };
  const dur = Math.round(
    Math.min(params.maxTransitionMs, beatMs * params.transitionBeatFraction),
  );
  return { type, durationMs: Math.max(0, Math.min(2000, dur)) };
}

function mkOverlay(type: OverlayType, intensity: number): Overlay | undefined {
  if (type === 'none') return undefined;
  return { type, intensity: Math.max(0, Math.min(1, intensity)) };
}

/* -------------------------------------------------------------------------- */
/*  selection / ordering                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Order the pool for placement. Higher score first puts the best material up
 * front, but we keep it DETERMINISTIC by breaking ties on mediaRef. We do NOT
 * drop low scorers here — the allocator cycles through them only if the strong
 * ones don't fill 30s.
 */
function orderItems(items: BuildItem[]): BuildItem[] {
  return [...items].sort((a, b) => {
    const ds = b.score.score - a.score.score;
    if (Math.abs(ds) > 1e-6) return ds;
    return a.mediaRef < b.mediaRef ? -1 : a.mediaRef > b.mediaRef ? 1 : 0;
  });
}

/* -------------------------------------------------------------------------- */
/*  core build                                                                  */
/* -------------------------------------------------------------------------- */

export function buildEdl(input: BuildEdlInput): Edl {
  if (input.items.length === 0) {
    throw new Error('buildEdl: no media items supplied');
  }

  // Resolve theme deterministically (seed Random by pool size so it's stable).
  const concreteTheme = resolveTheme(input.theme, input.items.length);
  const params = getThemeParams(concreteTheme);

  const beats = windowBeats(input.track.beatGridMs);
  if (beats.length < 2) {
    throw new Error('buildEdl: track beat grid does not cover the 30s window');
  }
  const beatMs = 60_000 / input.track.bpm;
  const drops = (input.track.dropsMs ?? []).map(snapToFrame);

  const ordered = orderItems(input.items);

  // ---- walk the beat grid, allocate each segment a beat-aligned span -------
  const segments: EdlSegment[] = [];
  let beatIdx = 0;
  let mediaIdx = 0;
  let segIndex = 0;

  // The last grid index is the 30000 edge.
  const lastIdx = beats.length - 1;

  while (beatIdx < lastIdx) {
    const startMs = beats[beatIdx]!;

    // How many beats this cut spans: theme baseline, faster (fewer beats) when
    // near a drop / high-energy section.
    const energetic = nearDrop(startMs, drops, beatMs * 1.5);
    let beatsThisCut = energetic
      ? Math.max(params.minBeatsPerCut, Math.round(params.beatsPerCut / 2))
      : params.beatsPerCut;
    beatsThisCut = Math.max(1, beatsThisCut);

    let endBeatIdx = Math.min(beatIdx + beatsThisCut, lastIdx);

    // Snap-to-edge: if the remaining tail after this cut is shorter than a
    // single beat, extend this segment to the 30s edge so we never emit a sliver.
    if (lastIdx - endBeatIdx >= 1) {
      const tailMs = EDL_DURATION_MS - beats[endBeatIdx]!;
      if (tailMs < beatMs * 0.9) endBeatIdx = lastIdx;
    }

    let endMs = beats[endBeatIdx]!;
    if (endMs <= startMs) {
      // degenerate (duplicate beat) — advance and retry
      beatIdx++;
      continue;
    }
    if (endMs > EDL_DURATION_MS) endMs = EDL_DURATION_MS;

    const durationMs = endMs - startMs;
    const item = ordered[mediaIdx % ordered.length]!;
    const isVideo = item.mediaType === 'video';

    // ---- source trim ------------------------------------------------------
    let inMs = 0;
    let outMs = durationMs; // photos: hold length
    if (isVideo) {
      const srcLen = Math.max(1, item.sourceDurationMs ?? durationMs);
      // Trim a window of `durationMs` around the clip's best (highest-motion)
      // moment, clamped inside the source.
      const center =
        item.score.bestWindow != null
          ? (item.score.bestWindow.startMs + item.score.bestWindow.endMs) / 2
          : srcLen / 2;
      let wStart = Math.round(center - durationMs / 2);
      wStart = Math.max(0, Math.min(wStart, srcLen - 1));
      let wEnd = wStart + durationMs;
      if (wEnd > srcLen) {
        wEnd = srcLen;
        wStart = Math.max(0, wEnd - durationMs);
      }
      inMs = snapToFrame(wStart);
      outMs = snapToFrame(wEnd);
      if (outMs <= inMs) outMs = inMs + Math.max(FRAME_MS, durationMs);
      // If the source is shorter than the segment, the renderer holds the last
      // frame; that's acceptable (timeline duration is authoritative & gapless).
    }

    // ---- transitions (per theme) -----------------------------------------
    const isFirst = segIndex === 0;
    const isLast = endMs >= EDL_DURATION_MS;
    const transitionIn = isFirst
      ? undefined
      : mkTransition(params.defaultTransition, params, beatMs);
    const transitionOut = isLast
      ? undefined
      : mkTransition(params.defaultTransition, params, beatMs);

    segments.push({
      index: segIndex,
      mediaRef: item.mediaRef,
      mediaType: item.mediaType,
      inMs,
      outMs,
      startMs,
      durationMs,
      speed: 1,
      transitionIn,
      transitionOut,
      overlay: mkOverlay(params.defaultOverlay, params.overlayIntensity),
      score: Math.max(0, Math.min(1, item.score.score)),
    });

    segIndex++;
    mediaIdx++;
    beatIdx = endBeatIdx;
  }

  // ---- safety: enforce gapless + exact 30000ms fill ------------------------
  if (segments.length === 0) {
    throw new Error('buildEdl: produced no segments');
  }
  // Re-chain start/duration to guarantee zero gaps & exact total (frame-snapped
  // beats can drift by ≤1 frame; this repairs any drift while KEEPING the cut
  // on the original beat times we computed above).
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const prev = segments[i - 1];
    const start = prev ? prev.startMs + prev.durationMs : 0;
    seg.startMs = start;
    if (i === segments.length - 1) {
      seg.durationMs = EDL_DURATION_MS - start;
    }
    // keep the originally-allocated durationMs for non-last segments
    if (seg.durationMs < 1) seg.durationMs = 1;
  }

  // ---- assemble + validate -------------------------------------------------
  const edl: Edl = {
    version: 1,
    width: 1080,
    height: 1920,
    fps: EDL_FPS,
    aspect: '9:16',
    durationMs: EDL_DURATION_MS,
    audio: {
      musicId: input.track.musicId,
      startMs: input.track.startMs ?? 0,
      volume: input.volume ?? 0.9,
    },
    beatGrid: {
      bpm: input.track.bpm,
      beatsMs: beats,
      dropsMs: drops.filter((d) => d <= EDL_DURATION_MS),
    },
    themeStyle: {
      theme: concreteTheme,
      defaultTransition: params.defaultTransition,
      cutDensityBias: params.cutDensityBias,
      colorGrade: concreteTheme.toLowerCase().replace(/\s+/g, '_'),
      overlay: mkOverlay(params.defaultOverlay, params.overlayIntensity),
    },
    segments,
  };

  return edlSchema.parse(edl);
}
