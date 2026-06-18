/**
 * Media tooling barrel — ffprobe/ffmpeg helpers + a thumbnail generator.
 */
import { execa } from 'execa';
import { FFMPEG_PATH, probe } from './probe.js';

export { probe, probeRawText, FFMPEG_PATH, FFPROBE_PATH } from './probe.js';
export type { ProbeResult } from './probe.js';
export { startMediaServer } from './staticServer.js';
export type { MediaServer } from './staticServer.js';

/**
 * Extract a single frame from `videoPath` at `atSec` → a JPEG at `outPath`,
 * scaled to fit `maxWidth` (preserving aspect). Used as the montage thumbnail
 * fallback when `renderStill` isn't used. Deterministic (fixed seek time).
 */
export async function extractFrame(
  videoPath: string,
  outPath: string,
  atSec = 1,
  maxWidth = 540,
): Promise<string> {
  await execa(FFMPEG_PATH, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(atSec),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${maxWidth}:-2:flags=lanczos`,
    '-q:v',
    '3',
    outPath,
  ]);
  return outPath;
}

/** Generate a solid-color test JPEG (used to mint smoke-test media). */
export async function makeColorImage(
  outPath: string,
  color: string,
  width = 1080,
  height = 1920,
): Promise<string> {
  await execa(FFMPEG_PATH, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${width}x${height}`,
    '-frames:v',
    '1',
    outPath,
  ]);
  return outPath;
}

/** Generate a short test video (testsrc/color) — used to mint smoke-test media. */
export async function makeTestVideo(
  outPath: string,
  opts: { durationSec?: number; width?: number; height?: number; source?: string } = {},
): Promise<string> {
  const { durationSec = 4, width = 1080, height = 1920, source = 'testsrc2' } = opts;
  await execa(FFMPEG_PATH, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `${source}=size=${width}x${height}:rate=30:duration=${durationSec}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-t',
    String(durationSec),
    outPath,
  ]);
  return outPath;
}

export { probe as probeMedia };
