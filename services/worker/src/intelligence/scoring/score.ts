// Intelligence — per-clip scoring (M7 §2/§3). PURE + directly importable (NO
// essentia import, NO remotion import) — the §10 learning: the API may import the
// EDL/scoring helpers without pulling the WASM/AV stack, so this module shells to
// ffmpeg for frames and uses `sharp` only for cheap per-frame pixel stats.
//
// Photos get a near-flat score (lightly nudged by brightness/sharpness). Videos are
// sampled (a handful of ffmpeg frames) → per-frame sharpness (Laplacian variance),
// brightness, and inter-frame motion (mean abs diff) → the highest-scoring window is
// returned as `bestWindowMs`. If ffmpeg is ABSENT we degrade to a flat score and set
// `degraded`, never crash.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { extractVideoFrames, probeDurationMsPath } from "../../ffmpeg.ts";

export interface ScoreClipInput {
  mediaRef: string; // daily_media_item id (becomes the EDL segment mediaRef)
  mediaType: "photo" | "video";
  path: string; // local temp file
  durationMs?: number | null; // known source duration (videos); probed if absent
}

export interface ScoredClip {
  mediaRef: string;
  mediaType: "photo" | "video";
  score: number; // 0..1 overall clip quality
  bestWindowMs?: { inMs: number; outMs: number }; // video highlight window (hint)
  durationMs: number; // source duration (0 for photos)
  degraded?: boolean; // true when ffmpeg was unavailable → flat score
}

// Fixed analysis resolution — small enough for a cheap Laplacian, square so the
// kernel is trivial. sharp resizes (ignoring aspect) to GRID×GRID greyscale.
const GRID = 64;
const N_FRAMES = 8;
const DEFAULT_WINDOW_MS = 2200; // default highlight width around the best frame

interface FrameStats {
  brightness: number; // 0..1 mean luma
  sharpness: number; // 0..1 normalised Laplacian variance
  pixels: Uint8Array; // GRID*GRID greyscale (for motion diffing)
}

// Read GRID×GRID greyscale pixels of an image file via sharp; compute brightness +
// a normalised Laplacian-variance sharpness. Throws are caught by callers.
async function frameStats(path: string): Promise<FrameStats> {
  const { data } = await sharp(path)
    .resize(GRID, GRID, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = new Uint8Array(data.buffer, data.byteOffset, GRID * GRID);

  // Brightness.
  let sum = 0;
  for (let i = 0; i < px.length; i++) sum += px[i]!;
  const brightness = sum / px.length / 255;

  // Laplacian (4-neighbour) variance → blur reject. Interior pixels only.
  let lSum = 0;
  let lSumSq = 0;
  let n = 0;
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      const idx = y * GRID + x;
      const lap = 4 * px[idx]! - px[idx - 1]! - px[idx + 1]! - px[idx - GRID]! - px[idx + GRID]!;
      lSum += lap;
      lSumSq += lap * lap;
      n++;
    }
  }
  const mean = lSum / n;
  const variance = lSumSq / n - mean * mean;
  // Empirically variance ~0 (flat/blurry) .. several thousand (crisp). Squash to 0..1.
  const sharpness = clamp01(variance / 1500);

  return { brightness, sharpness, pixels: px };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// A brightness "centeredness" term: 1.0 around mid-exposure, falling off toward
// crushed blacks / blown highlights.
function exposureTerm(brightness: number): number {
  return clamp01(1 - Math.abs(brightness - 0.5) * 1.6);
}

// Per-frame interest used for window selection + the clip's overall score.
function frameInterest(s: FrameStats, motion: number): number {
  return clamp01(0.5 * s.sharpness + 0.3 * motion + 0.2 * exposureTerm(s.brightness));
}

async function scorePhoto(input: ScoreClipInput): Promise<ScoredClip> {
  // A near-flat 0.5, lightly nudged by exposure + sharpness (kept close to 0.5 so
  // photos never dominate or vanish vs videos).
  try {
    const s = await frameStats(input.path);
    const nudge = (s.sharpness * 0.5 + exposureTerm(s.brightness) * 0.5 - 0.5) * 0.2;
    return {
      mediaRef: input.mediaRef,
      mediaType: "photo",
      score: clamp01(0.5 + nudge),
      durationMs: 0,
    };
  } catch {
    // sharp couldn't decode (e.g. exotic format) → plain flat score.
    return { mediaRef: input.mediaRef, mediaType: "photo", score: 0.5, durationMs: 0, degraded: true };
  }
}

async function scoreVideo(input: ScoreClipInput): Promise<ScoredClip> {
  const durationMs = input.durationMs ?? (await probeDurationMsPath(input.path)) ?? 0;

  let frameDir: string | null = null;
  try {
    frameDir = await mkdtemp(join(tmpdir(), "t4score-"));
    const frames = await extractVideoFrames(input.path, durationMs || 1000, N_FRAMES, frameDir);

    if (frames.length === 0) {
      // ffmpeg absent / produced nothing → degrade to flat.
      return {
        mediaRef: input.mediaRef,
        mediaType: "video",
        score: 0.5,
        durationMs,
        degraded: true,
        bestWindowMs: windowAround(durationMs / 2, durationMs),
      };
    }

    const stats: FrameStats[] = [];
    for (const f of frames) {
      try {
        stats.push(await frameStats(f.path));
      } catch {
        // Skip a frame sharp can't read; keep the index aligned by pushing a null-ish.
        stats.push({ brightness: 0.5, sharpness: 0, pixels: new Uint8Array(GRID * GRID) });
      }
    }

    // Per-frame interest (motion = mean abs diff vs previous sampled frame).
    const interest: number[] = [];
    for (let i = 0; i < stats.length; i++) {
      let motion = 0;
      if (i > 0) {
        const a = stats[i]!.pixels;
        const b = stats[i - 1]!.pixels;
        let d = 0;
        for (let k = 0; k < a.length; k++) d += Math.abs(a[k]! - b[k]!);
        motion = clamp01(d / a.length / 64); // ~0..1 (64 grey-levels of avg motion ⇒ 1)
      }
      interest.push(frameInterest(stats[i]!, motion));
    }

    // Best single sampled frame → centre the highlight window on its timestamp.
    let bestIdx = 0;
    for (let i = 1; i < interest.length; i++) if (interest[i]! > interest[bestIdx]!) bestIdx = i;
    const bestAtMs = frames[bestIdx]!.atMs;

    const score = clamp01(interest.reduce((a, b) => a + b, 0) / interest.length);
    return {
      mediaRef: input.mediaRef,
      mediaType: "video",
      score,
      durationMs,
      bestWindowMs: windowAround(bestAtMs, durationMs),
    };
  } finally {
    if (frameDir) await rm(frameDir, { recursive: true, force: true }).catch(() => {});
  }
}

// A DEFAULT_WINDOW_MS-wide window centred on `centreMs`, clamped to [0, durationMs].
function windowAround(centreMs: number, durationMs: number): { inMs: number; outMs: number } {
  const dur = durationMs > 0 ? durationMs : DEFAULT_WINDOW_MS;
  const half = Math.min(DEFAULT_WINDOW_MS, dur) / 2;
  let inMs = centreMs - half;
  let outMs = centreMs + half;
  if (inMs < 0) {
    outMs -= inMs;
    inMs = 0;
  }
  if (outMs > dur) {
    inMs -= outMs - dur;
    outMs = dur;
  }
  if (inMs < 0) inMs = 0;
  return { inMs: Math.round(inMs), outMs: Math.round(outMs) };
}

// Score one clip. Photos → near-flat; videos → frame-sampled with a highlight window.
export async function scoreClip(input: ScoreClipInput): Promise<ScoredClip> {
  return input.mediaType === "video" ? scoreVideo(input) : scorePhoto(input);
}
