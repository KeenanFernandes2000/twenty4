/**
 * Per-clip scoring (§7.1 step 2) — algorithmic, NO ML.
 *
 * Cheap heuristics that let the montage "pick the good bits" instead of dumb
 * chronological trimming:
 *   - motion     — mean absolute frame-diff across sampled frames (video only;
 *                  photos = 0). Identifies the liveliest window of a clip.
 *   - sharpness  — variance-of-Laplacian; low ⇒ blurry → rejected/penalized.
 *   - brightness — mean luma; reject too-dark / blown-out.
 *   - facePresence — best-effort skin-tone fraction heuristic (no detector dep);
 *                    a positive bias when faces are likely present.
 *
 * Photos score flat/neutral (sharpness+brightness still computed so a blurry/
 * black photo is down-weighted). Each metric is normalized to 0..1 and combined
 * into an overall `score` (0..1) plus a `bestWindow` for videos (the highest-
 * motion beat-alignable region the EDL builder trims around).
 *
 * Implementation: `sharp` for image stats (and for analyzing extracted video
 * frames), ffmpeg for video frame extraction. Deterministic (fixed sample times).
 */
import { execa } from 'execa';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { MediaType } from '@twenty4/contracts/enums';

const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';

export interface ScorableItem {
  /** S3 key / mediaRef (stable id). */
  mediaRef: string;
  mediaType: MediaType;
  /** Local path to the actual file to analyze. */
  filePath: string;
  /** For video: source duration in ms (probed by the caller). */
  sourceDurationMs?: number;
}

export interface ClipScore {
  mediaRef: string;
  mediaType: MediaType;
  /** Overall quality 0..1 (combines the metrics below). */
  score: number;
  /** Per-metric (all 0..1) for diagnostics / tuning. */
  motion: number;
  sharpness: number;
  brightness: number;
  facePresence: number;
  /**
   * For VIDEO: the highest-scoring window [startMs,endMs] within the source the
   * EDL builder should trim around (beat-aligned later). For photos: undefined.
   */
  bestWindow?: { startMs: number; endMs: number };
}

const ANALYZE_W = 160; // downscale for cheap per-frame stats
const FRAME_SAMPLES = 8; // frames sampled across a video for motion/quality

/* -------------------------------------------------------------------------- */
/*  image stats (sharp)                                                         */
/* -------------------------------------------------------------------------- */

interface FrameStats {
  /** mean luma 0..255 */
  brightness: number;
  /** variance-of-Laplacian (sharpness proxy), unbounded */
  laplacianVar: number;
  /** fraction of pixels in a loose skin-tone range 0..1 */
  skinFraction: number;
  /** downscaled grayscale buffer for frame-diff motion */
  gray: Uint8Array;
  width: number;
  height: number;
}

/** Compute cheap per-frame stats from an image file via sharp. */
async function frameStats(filePath: string): Promise<FrameStats> {
  const img = sharp(filePath, { failOn: 'none' }).rotate();

  // Grayscale, downscaled, raw → brightness + Laplacian variance + frame-diff.
  const grayImg = img
    .clone()
    .resize(ANALYZE_W, ANALYZE_W, { fit: 'inside' })
    .grayscale();
  const { data: gray, info } = await grayImg
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;

  // brightness = mean luma
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i]!;
  const brightness = sum / gray.length;

  // variance-of-Laplacian (3x3 discrete Laplacian)
  let lapSum = 0;
  let lapSqSum = 0;
  let lapN = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = gray[y * w + x]!;
      const lap =
        4 * c -
        gray[(y - 1) * w + x]! -
        gray[(y + 1) * w + x]! -
        gray[y * w + (x - 1)]! -
        gray[y * w + (x + 1)]!;
      lapSum += lap;
      lapSqSum += lap * lap;
      lapN++;
    }
  }
  const lapMean = lapN ? lapSum / lapN : 0;
  const laplacianVar = lapN ? lapSqSum / lapN - lapMean * lapMean : 0;

  // skin fraction from a downscaled RGB (loose YCbCr-ish range)
  const { data: rgb, info: rgbInfo } = await img
    .clone()
    .resize(64, 64, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = rgbInfo.channels;
  let skin = 0;
  let px = 0;
  for (let i = 0; i + channels - 1 < rgb.length; i += channels) {
    const r = rgb[i]!;
    const g = rgb[i + 1]!;
    const b = rgb[i + 2]!;
    px++;
    // Loose RGB skin rule (Kovac et al.-ish): R>95,G>40,B>20, R>G, R>B, spread.
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (
      r > 95 &&
      g > 40 &&
      b > 20 &&
      mx - mn > 15 &&
      r > g &&
      r > b &&
      Math.abs(r - g) > 15
    ) {
      skin++;
    }
  }
  const skinFraction = px ? skin / px : 0;

  return { brightness, laplacianVar, skinFraction, gray, width: w, height: h };
}

/* -------------------------------------------------------------------------- */
/*  normalizers                                                                 */
/* -------------------------------------------------------------------------- */

/** Brightness 0..255 → quality 0..1: peak ~128, reject <25 (dark) / >235 (blown). */
function brightnessScore(b: number): number {
  if (b < 25 || b > 235) return Math.max(0, 0.2 - Math.abs(b - 130) / 600);
  // triangular peak at 128
  return 1 - Math.min(1, Math.abs(b - 128) / 128) * 0.6;
}

/** Laplacian variance → sharpness 0..1 (saturating). ~<10 = blurry. */
function sharpnessScore(v: number): number {
  // 0 at 0, ~0.5 around 80, saturates by ~600. Tuned for 160px frames.
  return Math.max(0, Math.min(1, Math.log10(1 + v) / Math.log10(1 + 600)));
}

/** Skin fraction → face-presence proxy 0..1 (best-effort, not a detector). */
function facePresenceScore(skinFraction: number): number {
  // A meaningful face occupies a non-trivial fraction; cap so backgrounds with
  // warm tones don't dominate. // TODO(scoring): swap for a tiny face detector.
  if (skinFraction < 0.02) return 0;
  return Math.min(1, skinFraction / 0.25);
}

/* -------------------------------------------------------------------------- */
/*  video frame extraction + motion                                             */
/* -------------------------------------------------------------------------- */

/** Extract `n` JPEG frames evenly across [0,durationMs] → file paths. */
async function extractFrames(
  videoPath: string,
  durationMs: number,
  n: number,
  outDir: string,
): Promise<{ ms: number; file: string }[]> {
  const out: { ms: number; file: string }[] = [];
  const span = Math.max(1, durationMs);
  for (let i = 0; i < n; i++) {
    // Sample within (0,1) avoiding the exact endpoints.
    const frac = (i + 0.5) / n;
    const atSec = (span * frac) / 1000;
    const file = path.join(outDir, `f${i}.jpg`);
    await execa(FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      atSec.toFixed(3),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${ANALYZE_W}:-2`,
      '-q:v',
      '3',
      file,
    ]).catch(() => undefined);
    out.push({ ms: Math.round(span * frac), file });
  }
  // Keep only frames ffmpeg actually wrote.
  const written = new Set(await readdir(outDir).catch(() => []));
  return out.filter((f) => written.has(path.basename(f.file)));
}

/** Mean absolute per-pixel diff between two equal-size grayscale buffers → 0..1. */
function frameDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / n / 255;
}

/* -------------------------------------------------------------------------- */
/*  public scoring                                                              */
/* -------------------------------------------------------------------------- */

function combine(
  motion: number,
  sharpness: number,
  brightness: number,
  facePresence: number,
  mediaType: MediaType,
): number {
  // Weights: quality (sharp+bright) gates everything; motion & faces add interest.
  // Photos have no motion, so re-weight toward quality + faces.
  if (mediaType === 'photo') {
    return clamp01(0.45 * sharpness + 0.3 * brightness + 0.25 * facePresence);
  }
  return clamp01(
    0.3 * sharpness + 0.2 * brightness + 0.3 * motion + 0.2 * facePresence,
  );
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Score a single media item. */
export async function scoreMedia(item: ScorableItem): Promise<ClipScore> {
  if (item.mediaType === 'photo') {
    const s = await frameStats(item.filePath);
    const sharpness = sharpnessScore(s.laplacianVar);
    const brightness = brightnessScore(s.brightness);
    const facePresence = facePresenceScore(s.skinFraction);
    return {
      mediaRef: item.mediaRef,
      mediaType: 'photo',
      motion: 0, // photos are static (§7.1: photos get a flat score)
      sharpness,
      brightness,
      facePresence,
      score: combine(0, sharpness, brightness, facePresence, 'photo'),
    };
  }

  // VIDEO: sample frames, compute quality + motion + best window.
  const durationMs = item.sourceDurationMs ?? 0;
  const dir = await mkdtemp(path.join(tmpdir(), 'twenty4-score-'));
  try {
    const frames = await extractFrames(item.filePath, durationMs, FRAME_SAMPLES, dir);
    if (frames.length === 0) {
      // Could not decode any frame — neutral-low score, no best window.
      return {
        mediaRef: item.mediaRef,
        mediaType: 'video',
        motion: 0,
        sharpness: 0.3,
        brightness: 0.5,
        facePresence: 0,
        score: 0.3,
      };
    }

    const stats = await Promise.all(frames.map((f) => frameStats(f.file)));

    // per-frame quality
    const sharpVals = stats.map((s) => sharpnessScore(s.laplacianVar));
    const brightVals = stats.map((s) => brightnessScore(s.brightness));
    const faceVals = stats.map((s) => facePresenceScore(s.skinFraction));
    const sharpness = mean(sharpVals);
    const brightness = mean(brightVals);
    const facePresence = mean(faceVals);

    // motion: mean abs frame-diff between consecutive sampled frames
    const diffs: number[] = [];
    for (let i = 1; i < stats.length; i++) {
      diffs.push(frameDiff(stats[i - 1]!.gray, stats[i]!.gray));
    }
    const motionRaw = diffs.length ? mean(diffs) : 0;
    // Normalize: a busy testsrc clip diffs ~0.1-0.3; saturate by 0.35.
    const motion = clamp01(motionRaw / 0.35);

    // best window: center on the consecutive pair with the most motion +
    // good quality. Each sampled frame represents a ~span/n region.
    const bestWindow = pickBestWindow(frames, diffs, durationMs);

    return {
      mediaRef: item.mediaRef,
      mediaType: 'video',
      motion,
      sharpness,
      brightness,
      facePresence,
      score: combine(motion, sharpness, brightness, facePresence, 'video'),
      bestWindow,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Pick the highest-motion region of the clip as [startMs,endMs]. */
function pickBestWindow(
  frames: { ms: number; file: string }[],
  diffs: number[],
  durationMs: number,
): { startMs: number; endMs: number } {
  if (frames.length < 2 || durationMs <= 0) {
    return { startMs: 0, endMs: Math.max(1, durationMs) };
  }
  // index of the max-diff consecutive pair (diffs[i] = between frame i and i+1)
  let bestIdx = 0;
  let bestVal = -1;
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i]! > bestVal) {
      bestVal = diffs[i]!;
      bestIdx = i;
    }
  }
  // center the window on the midpoint of that pair
  const mid = (frames[bestIdx]!.ms + frames[bestIdx + 1]!.ms) / 2;
  return { startMs: Math.round(mid), endMs: durationMs };
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Score many items (bounded concurrency to avoid ffmpeg storms). */
export async function scoreMany(
  items: ScorableItem[],
  concurrency = 8,
): Promise<ClipScore[]> {
  const results: ClipScore[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await scoreMedia(items[i]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}
