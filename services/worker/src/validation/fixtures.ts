/**
 * Fixtures helper for the §7.5 gate — generate a mixed pool of media items with
 * ffmpeg so the harness can exercise the full intelligence + render pipeline
 * WITHOUT real user uploads.
 *
 * The pool mixes:
 *   - PHOTOS: solid colors, gradients, and `testsrc` stills (varied brightness so
 *     scoring's bright/dark rejection has signal).
 *   - VIDEOS: `testsrc2` / `mandelbrot` / `smptebars` / `color` clips of varied
 *     length (2-8s) and motion (mandelbrot & testsrc2 are high-motion; a static
 *     `color` clip is low-motion) so motion scoring + best-window picking has
 *     signal.
 *
 * Deterministic for a given `seed` (same files, same params every run) so the
 * gate is reproducible. Returns the items + a cleanup fn.
 */
import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MediaType } from '@twenty4/contracts/enums';

const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';
const W = 1080;
const H = 1920;

export interface FixtureItem {
  mediaRef: string;
  mediaType: MediaType;
  filePath: string;
  /** For video: the real source duration in ms. */
  sourceDurationMs?: number;
}

export interface FixturePool {
  dir: string;
  items: FixtureItem[];
  cleanup(): Promise<void>;
}

/** Small seeded PRNG (mulberry32) for deterministic, varied fixtures. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PHOTO_COLORS = [
  '0xff7a52', // accent
  '0x1fa572', // success green
  '0x223344', // dark blue (low brightness)
  '0xf3ebe3', // near-white field (high brightness)
  '0xec5430', // accent red
  '0x8a7a6d', // muted
  '0x0a0a0c', // near-black (dark-reject signal)
  '0xfbf6f1', // bg light (blown-reject signal)
];

const VIDEO_SOURCES = [
  'testsrc2', // high motion, sharp
  'mandelbrot', // very high motion
  'smptebars', // static bars (low motion, sharp)
  'rgbtestsrc', // moderate
] as const;

async function makePhoto(
  outPath: string,
  spec: { source: 'color' | 'gradient' | 'testsrc'; color?: string },
): Promise<void> {
  let input: string;
  if (spec.source === 'testsrc') {
    input = `testsrc=size=${W}x${H}:rate=1:duration=1`;
  } else if (spec.source === 'gradient') {
    // `gradients` is not on all builds; the caller falls back to a solid color.
    input = `gradients=s=${W}x${H}:c0=${spec.color ?? '0x223344'}:c1=0xff7a52`;
  } else {
    input = `color=c=${spec.color ?? '0xff7a52'}:s=${W}x${H}`;
  }
  await execa(FFMPEG_PATH, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    input,
    '-frames:v',
    '1',
    outPath,
  ]);
}

async function makeVideo(
  outPath: string,
  opts: { source: string; durationSec: number },
): Promise<void> {
  const src =
    opts.source === 'color'
      ? `color=c=0x223344:s=${W}x${H}:rate=30:duration=${opts.durationSec}`
      : `${opts.source}=size=${W}x${H}:rate=30:duration=${opts.durationSec}`;
  await execa(FFMPEG_PATH, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    src,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-t',
    String(opts.durationSec),
    outPath,
  ]);
}

/**
 * Generate a mixed pool of `count` items (default 50): ~60% photos, ~40% videos.
 * `videoConcurrency` bounds parallel ffmpeg encodes.
 */
export async function generateFixturePool(opts: {
  count?: number;
  seed?: number;
  dir?: string;
  videoConcurrency?: number;
}): Promise<FixturePool> {
  const count = opts.count ?? 50;
  const seed = opts.seed ?? 1;
  const rand = rng(seed);
  const dir = opts.dir ?? (await mkdtemp(path.join(tmpdir(), 'twenty4-fixtures-')));

  // Decide the composition: ~60% photos.
  const specs: {
    mediaRef: string;
    mediaType: MediaType;
    filePath: string;
    make: () => Promise<void>;
    sourceDurationMs?: number;
  }[] = [];

  let photoN = 0;
  let videoN = 0;
  for (let i = 0; i < count; i++) {
    const isPhoto = rand() < 0.6;
    if (isPhoto) {
      const ref = `fixture-photo-${photoN}.jpg`;
      const filePath = path.join(dir, ref);
      const roll = rand();
      const kind: 'color' | 'gradient' | 'testsrc' =
        roll < 0.5 ? 'color' : roll < 0.8 ? 'testsrc' : 'gradient';
      const color = PHOTO_COLORS[photoN % PHOTO_COLORS.length]!;
      specs.push({
        mediaRef: ref,
        mediaType: 'photo',
        filePath,
        make: () =>
          makePhoto(filePath, { source: kind, color }).catch(() =>
            // gradient/testsrc fallback → solid color (some builds lack filters)
            makePhoto(filePath, { source: 'color', color }),
          ),
      });
      photoN++;
    } else {
      const ref = `fixture-video-${videoN}.mp4`;
      const filePath = path.join(dir, ref);
      // varied length 2-8s
      const durationSec = 2 + Math.floor(rand() * 7);
      const source =
        rand() < 0.15
          ? 'color' // low-motion clip
          : VIDEO_SOURCES[videoN % VIDEO_SOURCES.length]!;
      specs.push({
        mediaRef: ref,
        mediaType: 'video',
        filePath,
        sourceDurationMs: durationSec * 1000,
        make: () =>
          makeVideo(filePath, { source, durationSec }).catch(() =>
            makeVideo(filePath, { source: 'testsrc2', durationSec }),
          ),
      });
      videoN++;
    }
  }

  // Generate with bounded concurrency (24 cores available, but cap to be kind).
  const concurrency = opts.videoConcurrency ?? 12;
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= specs.length) return;
      await specs[i]!.make();
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, specs.length) }, () => worker()),
  );

  const items: FixtureItem[] = specs.map((s) => ({
    mediaRef: s.mediaRef,
    mediaType: s.mediaType,
    filePath: s.filePath,
    sourceDurationMs: s.sourceDurationMs,
  }));

  return {
    dir,
    items,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
