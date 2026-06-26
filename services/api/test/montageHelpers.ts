// M7 montage test helpers — build the full app (auth + groups + media + montage
// wired) with an INJECTED render-montage queue (unique name so no running prod
// worker drains it) so tests can observe enqueues + jobIds without a real render.
// Montage rows are seeded directly in the needed statuses (the worker agent owns
// the actual render gate).
import { buildApp } from "../src/app.ts";
import { createDb, type DbClient } from "../src/db.ts";
import { createRedis, type RedisClient } from "../src/redis.ts";
import { parseEnv, resolveDayBucket, type Env } from "@twenty4/contracts";
import { dailyMediaItem, montage } from "@twenty4/contracts/db";
import { Queue, type ConnectionOptions } from "bullmq";
import type { RenderMontageJobData } from "../src/montage/queue.ts";
import { phoneLogin } from "./authHelpers.ts";
import { loadEnvForTest } from "./env.ts";

export function makeMontageEnv(overrides: Partial<Record<string, string>> = {}): Env {
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
    ...overrides,
  });
}

export function makeMontageDb(): DbClient {
  return createDb(process.env.DATABASE_URL!);
}

export function makeMontageRedis(): RedisClient {
  return createRedis(process.env.REDIS_URL!);
}

let testQueueSeq = 0;
function redisConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null };
}

// An isolated queue whose unique name no prod render-montage worker consumes (so
// the API's enqueues sit untouched for inspection). pid + counter is sufficient.
export function makeMontageQueue(env: Env): Queue<RenderMontageJobData> {
  const name = `render-montage-test-${process.pid}-${testQueueSeq++}`;
  return new Queue<RenderMontageJobData>(name, { connection: redisConnection(env.REDIS_URL) });
}

export async function buildMontageApp(args: {
  db: DbClient;
  redis: RedisClient;
  env: Env;
  queue: Queue<RenderMontageJobData>;
}) {
  const app = await buildApp({
    db: args.db,
    redis: args.redis,
    env: args.env,
    nodeEnv: "test",
    montageQueue: args.queue,
  });
  await app.ready();
  return app;
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function seedUsers(
  app: Awaited<ReturnType<typeof buildMontageApp>>,
  phones: string[],
): Promise<{ token: string; userId: string; phone: string }[]> {
  const out: { token: string; userId: string; phone: string }[] = [];
  for (const phone of phones) {
    const { token, userId } = await phoneLogin(app, phone);
    out.push({ token, userId, phone });
  }
  return out;
}

// Today's bucket for a freshly-seeded user (no media init yet ⇒ canonical tz null
// ⇒ the route resolves the bucket from UTC; seeds must match).
export function todayBucket(): string {
  return resolveDayBucket(new Date(), "UTC");
}

// Insert `count` VALID, non-deleted media rows for the user's today bucket and
// return their ids (the render candidate pool).
export async function seedValidMedia(db: DbClient, userId: string, count: number): Promise<string[]> {
  const bucket = todayBucket();
  const values = Array.from({ length: count }, (_, i) => ({
    userId,
    dayBucket: bucket,
    mediaType: "photo" as const,
    storagePath: `media/${userId}/seed-${i}`,
    processingStatus: "valid" as const,
    validationStatus: "valid" as const,
  }));
  const rows = await db.db.insert(dailyMediaItem).values(values).returning({ id: dailyMediaItem.id });
  return rows.map((r) => r.id);
}

// Seed a montage row directly in a chosen status/day (the worker owns real renders).
export async function seedMontage(
  db: DbClient,
  args: {
    userId: string;
    status: "generating" | "draft_ready" | "published" | "failed" | "not_generated";
    dayBucket?: string;
    videoPath?: string | null;
    thumbnailPath?: string | null;
    durationMs?: number | null;
    theme?: string;
    musicId?: string;
    sourceMediaIds?: string[];
    publishedAt?: Date | null;
    expiryAt?: Date | null;
  },
): Promise<string> {
  const rows = await db.db
    .insert(montage)
    .values({
      userId: args.userId,
      dayBucket: args.dayBucket ?? todayBucket(),
      status: args.status,
      theme: args.theme ?? "clean",
      musicId: args.musicId ?? "clean",
      videoPath: args.videoPath ?? null,
      thumbnailPath: args.thumbnailPath ?? null,
      durationMs: args.durationMs ?? null,
      sourceMediaIds: args.sourceMediaIds ?? [],
      publishedAt: args.publishedAt ?? null,
      expiryAt: args.expiryAt ?? null,
    })
    .returning({ id: montage.id });
  return rows[0]!.id;
}

export async function createGroup(
  app: Awaited<ReturnType<typeof buildMontageApp>>,
  token: string,
  name: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/groups",
    headers: { "content-type": "application/json", ...bearer(token) },
    payload: JSON.stringify({ name }),
  });
  if (res.statusCode !== 201) throw new Error(`createGroup failed: ${res.statusCode} ${res.body}`);
  return res.json().id as string;
}

export async function cleanupByPhones(db: DbClient, phones: string[]): Promise<void> {
  for (const phone of phones) {
    // montage_group_visibility cascades from montage (user) + group; delete owned
    // groups first, then users (montage + media cascade from user.id).
    await db.sql`DELETE FROM "group" WHERE owner_id IN (SELECT id FROM "user" WHERE phone = ${phone})`;
    await db.sql`DELETE FROM "user" WHERE phone = ${phone}`;
  }
}
