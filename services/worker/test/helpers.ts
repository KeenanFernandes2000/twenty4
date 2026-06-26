// Worker live-stack test helpers (M7). Loads the repo-root .env (Bun only auto-loads
// .env from cwd), builds the worker db/s3, and provides direct seed/upload/ffprobe
// utilities so the render-gate test can drive processRenderMontage synchronously
// against real Postgres + MinIO + a real Remotion render.
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import { parseEnv, type Env } from "@twenty4/contracts";

let loaded = false;
function loadRootDotenv(): void {
  if (loaded) return;
  loaded = true;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let val = m[2]!;
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
      }
      return;
    }
    dir = dirname(dir);
  }
}

export function loadWorkerEnv(): Env {
  loadRootDotenv();
  return parseEnv({ ...process.env, NODE_ENV: "test" });
}

export const FIXTURES_DIR = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "fixtures", "sample-media");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("fixtures/sample-media not found");
})();

export function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

// HeadObject existence check on an arbitrary bucket/key (null-safe → boolean).
export async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (name === "NotFound" || name === "NoSuchKey" || status === 404) return false;
    throw err;
  }
}

// Count objects under a prefix (for the no-orphans assertion).
export async function countObjects(client: S3Client, bucket: string, prefix: string): Promise<number> {
  const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return res.KeyCount ?? (res.Contents?.length ?? 0);
}

export async function downloadObject(client: S3Client, bucket: string, key: string): Promise<Buffer> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> };
  return Buffer.from(await body.transformToByteArray!());
}

export interface ProbeStreams {
  width: number;
  height: number;
  fps: number;
  codec: string;
  durationSec: number;
}

// ffprobe a local mp4 file → video stream geometry + codec + duration.
export async function ffprobeStreams(file: string): Promise<ProbeStreams> {
  const bin = process.env.FFPROBE_PATH ?? "/home/keenan/bin/ffprobe";
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      file,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
  });
  const json = JSON.parse(out) as {
    streams: Array<Record<string, unknown>>;
    format: { duration?: string };
  };
  const v = json.streams.find((s) => s.codec_type === "video")!;
  const parts = String(v.r_frame_rate ?? "0/1").split("/");
  const num = Number(parts[0] ?? 0);
  const den = Number(parts[1] ?? 1);
  return {
    width: Number(v.width),
    height: Number(v.height),
    fps: den ? num / den : num,
    codec: String(v.codec_name),
    durationSec: Number(json.format.duration ?? 0),
  };
}
