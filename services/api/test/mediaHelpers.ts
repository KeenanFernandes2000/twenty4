// M4 media test helpers — build the full app (auth + groups + media wired) with an
// INJECTED validate-media queue so tests can both observe enqueues and run the
// worker job SYNCHRONOUSLY against the live stack (concurrency 1 → deterministic).
import { buildApp } from "../src/app.ts";
import { createDb, type DbClient } from "../src/db.ts";
import { createRedis, type RedisClient } from "../src/redis.ts";
import { parseEnv, type Env } from "@twenty4/contracts";
import { type ValidateMediaJobData } from "../src/media/queue.ts";
import { createWorkerDb } from "@twenty4/worker";
import { createWorkerS3 } from "@twenty4/worker";
import { processValidateMedia } from "@twenty4/worker";
import { loadEnvForTest } from "./env.ts";
import { phoneLogin } from "./authHelpers.ts";
import { Queue, type ConnectionOptions } from "bullmq";

export function makeMediaEnv(): Env {
  loadEnvForTest();
  return parseEnv({
    ...process.env,
    NODE_ENV: "test",
    OTP_MAX_PER_IP: "100000",
    OTP_MAX_PER_IDENTIFIER: "100000",
    OTP_VERIFY_MAX_ATTEMPTS: "100000",
    OTP_WINDOW_SEC: "900",
    INVITE_CREATE_CAP: "100000",
    INVITE_JOIN_CAP: "100000",
    INVITE_WINDOW_SEC: "900",
  });
}

export function makeMediaDb(): DbClient {
  return createDb(process.env.DATABASE_URL!);
}

export function makeMediaRedis(): RedisClient {
  return createRedis(process.env.REDIS_URL!);
}

// ── ISOLATED test queue ──────────────────────────────────────────────────────
// The production validate-media worker listens on the FIXED queue name
// `validate-media`. If the test queue used that same name, a running prod worker
// would consume test-created jobs and advance/mutate the row's processing_status
// mid-test (validating→valid/invalid), corrupting state assertions and enqueue
// counts. So tests inject a queue with a UNIQUE name the prod worker is NOT
// consuming. The API only ever ADDs to whatever queue it's handed; validation
// happy-paths run the processor IN-PROCESS (runValidateMediaJob) against the DB
// row directly — they never depend on the BullMQ worker — so an isolated,
// never-drained test queue is exactly what we want.
//
// Uniqueness is derived from process.pid + a monotonic counter (NO Date.now /
// Math.random — those may be restricted/non-deterministic in the runtime, and pid
// + counter is sufficient: the prod worker only ever consumes the literal
// `validate-media` name).
let testQueueSeq = 0;

function redisConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null };
}

export function makeMediaQueue(env: Env): Queue<ValidateMediaJobData> {
  const name = `validate-media-test-${process.pid}-${testQueueSeq++}`;
  return new Queue<ValidateMediaJobData>(name, { connection: redisConnection(env.REDIS_URL) });
}

export async function buildMediaApp(args: {
  db: DbClient;
  redis: RedisClient;
  env: Env;
  queue: Queue<ValidateMediaJobData>;
}) {
  const app = await buildApp({
    db: args.db,
    redis: args.redis,
    env: args.env,
    nodeEnv: "test",
    mediaQueue: args.queue,
  });
  await app.ready();
  return app;
}

// Run the validate-media processor SYNCHRONOUSLY against the live stack (mirrors
// what the BullMQ worker would do, without spinning a Worker process). Uses the
// worker package's real db + s3 wiring.
export async function runValidateMediaJob(env: Env, mediaId: string): Promise<void> {
  const wdb = createWorkerDb(env.DATABASE_URL);
  const ws3 = createWorkerS3(env);
  try {
    await processValidateMedia({ db: wdb, s3: ws3 }, { mediaId });
  } finally {
    await wdb.sql.end({ timeout: 5 });
  }
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function seedUsers(
  app: Awaited<ReturnType<typeof buildMediaApp>>,
  phones: string[],
): Promise<{ token: string; userId: string; phone: string }[]> {
  const out: { token: string; userId: string; phone: string }[] = [];
  for (const phone of phones) {
    const { token, userId } = await phoneLogin(app, phone);
    out.push({ token, userId, phone });
  }
  return out;
}

export async function cleanupMediaByPhones(db: DbClient, phones: string[]): Promise<void> {
  for (const phone of phones) {
    // daily_media_item cascades from user.id; delete users to clean up.
    await db.sql`DELETE FROM "user" WHERE phone = ${phone}`;
  }
}

// Real HTTP PUT of bytes to a presigned URL (the device-side transport). We use
// fetch against the public-endpoint host. Note: tests run on the host, which CAN
// reach the Tailscale IP (confirmed in M0).
export async function putBytes(uploadUrl: string, bytes: Buffer, contentType: string): Promise<number> {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: bytes,
  });
  // Drain the body so the socket frees up.
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}

// Real HTTP GET of bytes from a presigned URL → Buffer.
export async function getBytes(downloadUrl: string): Promise<Buffer> {
  const res = await fetch(downloadUrl);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
