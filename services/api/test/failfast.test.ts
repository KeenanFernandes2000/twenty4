// Fail-fast boot assertions — spawn the real entrypoint as a subprocess with a
// broken environment and assert it exits NON-ZERO before listening.
import { expect, test } from "bun:test";

const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;

// A complete, valid base env (mirrors the live .env) we then break per-test.
// We START from process.env (so Bun can resolve node_modules / PATH) and override
// the API config keys explicitly — explicit env always wins over .env auto-load.
function baseEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: "postgres://twenty4:twenty4@localhost:5433/twenty4",
    REDIS_URL: "redis://localhost:6380",
    S3_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY: "minioadmin",
    S3_SECRET_KEY: "minioadmin",
    S3_REGION: "us-east-1",
    S3_BUCKET_RAW: "raw",
    S3_BUCKET_MONTAGES: "montages",
    S3_BUCKET_THUMBNAILS: "thumbnails",
    API_HOST: "127.0.0.1",
    // A real (free-ish) port. A successful boot would listen here; the broken-env
    // cases exit before listen. We kill any survivor in boot().
    API_PORT: "39517",
  };
}

// Spawn index.ts. We run from a tmp cwd WITHOUT a .env so a deleted/overridden var
// can't be silently refilled by the repo .env auto-load. node_modules still resolves
// via the absolute entry path + inherited NODE_PATH/PATH in env.
async function boot(env: Record<string, string | undefined>): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", ENTRY], {
    cwd: "/tmp",
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Give a successful boot a chance to start listening, then kill it so the test
  // doesn't hang. A failing boot exits on its own well before this.
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, 12000);

  // Drain stderr CONCURRENTLY with awaiting exit — reading the pipe only after
  // exit can return empty for slower-exiting processes (drained/closed buffer).
  const stderrPromise = new Response(proc.stderr).text();
  const [code, stderr] = await Promise.all([proc.exited, stderrPromise]);
  clearTimeout(timer);
  return { code, stderr };
}

test("missing required env var → non-zero exit", async () => {
  const env = baseEnv();
  delete (env as Record<string, string | undefined>).DATABASE_URL;
  const { code, stderr } = await boot(env);
  expect(code).not.toBe(0);
  expect(stderr).toContain("env");
});

test(
  "unreachable DATABASE_URL → DB-verify fail-fast non-zero exit",
  async () => {
    const env = baseEnv();
    // Valid shape, unreachable host/port (nothing listens on 5599).
    env.DATABASE_URL = "postgres://twenty4:twenty4@127.0.0.1:5599/twenty4";
    env.DB_CONNECT_TIMEOUT = "2"; // fail fast so the test doesn't stall.
    const { code, stderr } = await boot(env);
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("db");
  },
  15000,
);

test("prod placeholder secret → non-zero exit", async () => {
  const env = baseEnv();
  env.NODE_ENV = "production";
  // S3_ACCESS_KEY/SECRET are 'minioadmin' placeholders → guard must refuse boot.
  const { code, stderr } = await boot(env);
  expect(code).not.toBe(0);
  expect(stderr.toLowerCase()).toContain("placeholder");
});
