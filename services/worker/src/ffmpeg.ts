// ffmpeg/ffprobe shell helpers (M7) — mirrors probe.ts's spawn-a-static-binary
// pattern. The worker stays on Bun and shells out to the ffmpeg/ffprobe binaries
// (intelligence scoring + the video-poster frame), never importing a native AV lib.
//
// Binary resolution order (cached): $FFMPEG_PATH / $FFPROBE_PATH → the bare name on
// PATH → /home/keenan/bin/<name>. If none answer `-version`, the resolver returns
// null and the caller DEGRADES GRACEFULLY (flat scores / skipped poster) — a missing
// ffmpeg must never crash a render.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const FFMPEG_CANDIDATES = [process.env.FFMPEG_PATH, "ffmpeg", "/home/keenan/bin/ffmpeg"].filter(
  Boolean,
) as string[];
const FFPROBE_CANDIDATES = [process.env.FFPROBE_PATH, "ffprobe", "/home/keenan/bin/ffprobe"].filter(
  Boolean,
) as string[];

let ffmpegResolved: string | null | undefined;
let ffprobeResolved: string | null | undefined;

// Spawn `<bin> -version`; resolves true iff it exits 0 (the binary is usable).
function canRun(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["-version"]);
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// First candidate that answers `-version` wins (cached for the process lifetime).
export async function ffmpegPath(): Promise<string | null> {
  if (ffmpegResolved !== undefined) return ffmpegResolved;
  for (const cand of FFMPEG_CANDIDATES) {
    if (await canRun(cand)) {
      ffmpegResolved = cand;
      return cand;
    }
  }
  ffmpegResolved = null;
  return null;
}

export async function ffprobePath(): Promise<string | null> {
  if (ffprobeResolved !== undefined) return ffprobeResolved;
  for (const cand of FFPROBE_CANDIDATES) {
    if (await canRun(cand)) {
      ffprobeResolved = cand;
      return cand;
    }
  }
  ffprobeResolved = null;
  return null;
}

function runToClose(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// Probe a file's duration (ms) by PATH. Null if ffprobe is absent or it can't read.
export async function probeDurationMsPath(file: string): Promise<number | null> {
  const bin = await ffprobePath();
  if (!bin) return null;
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr))));
  }).catch(() => "");
  const seconds = parseFloat(out);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

// Extract one small JPEG frame at `atSec` seconds. Fast input-seek (-ss before -i).
// `width` downscales (height auto, even). Returns true on success.
export async function extractFrameJpeg(
  file: string,
  atSec: number,
  outPath: string,
  width = 160,
): Promise<boolean> {
  const bin = await ffmpegPath();
  if (!bin) return false;
  try {
    await runToClose(bin, [
      "-y",
      "-ss",
      Math.max(0, atSec).toFixed(3),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:-2`,
      "-q:v",
      "5",
      outPath,
    ]);
    return true;
  } catch {
    return false;
  }
}

// Extract N evenly-spaced poster frames for video scoring into `outDir`. Returns the
// successfully-written frame paths (in time order) paired with their sample time (ms).
export async function extractVideoFrames(
  file: string,
  durationMs: number,
  count: number,
  outDir: string,
): Promise<{ path: string; atMs: number }[]> {
  await mkdir(outDir, { recursive: true });
  const frames: { path: string; atMs: number }[] = [];
  const span = Math.max(1, durationMs);
  for (let i = 0; i < count; i++) {
    // Sample across the interior (avoid the very first/last frame).
    const frac = (i + 0.5) / count;
    const atMs = Math.min(span - 1, Math.max(0, frac * span));
    const p = join(outDir, `frame_${i}.jpg`);
    if (await extractFrameJpeg(file, atMs / 1000, p, 160)) {
      frames.push({ path: p, atMs });
    }
  }
  return frames;
}

// Extract a single representative poster JPEG (M7 §12 video poster). Best-effort:
// returns true on success, false (caller continues) if ffmpeg is missing or fails.
export async function extractPosterJpeg(file: string, atSec: number, outPath: string): Promise<boolean> {
  // Larger than scoring frames — this is the user-facing card poster.
  return extractFrameJpeg(file, atSec, outPath, 720);
}
