// Video duration probe (M4) — uses ffprobe to read duration_ms from a buffer.
//
// ffprobe is a static binary on this box (/home/keenan/bin/ffprobe). We write the
// bytes to a temp file (ffprobe can read stdin via pipe:0 but seeking MP4 moov
// atoms is unreliable on a pipe) and read format.duration.
//
// FFPROBE_PATH overrides the binary location (defaults to `ffprobe` on PATH).
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

// Run ffprobe on a buffer, returning duration in ms (rounded), or null if it
// can't be determined.
export async function probeDurationMs(bytes: Buffer): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), "t4probe-"));
  const file = join(dir, "media");
  try {
    await writeFile(file, bytes);
    const out = await runFfprobe(file);
    const seconds = parseFloat(out);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runFfprobe(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ];
    const child = spawn(FFPROBE, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`ffprobe exited ${code}: ${stderr}`));
    });
  });
}
