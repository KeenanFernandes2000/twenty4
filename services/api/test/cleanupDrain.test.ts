// M9 cleanup — CROSS-SERVICE DRAIN proof (live PG + Redis + MinIO).
//
// THE point: the API enqueue helpers and the worker processors agreed only on queue
// names + jobId formatters; the job-DATA field names were chosen independently. The
// existing suites never cross the wire (the worker tests its processors with its own
// seeded data shapes; the API tests enqueue without draining through the real
// worker), so a field-name drift would leave BOTH green while the 24h-expiry pipeline
// silently no-ops in prod.
//
// This suite closes that gap: for each of the 4 one-shot jobs it ENQUEUES with the
// API's REAL enqueue helper into a REAL BullMQ queue, re-reads the job back out of
// Redis (real round-trip serialization), then drains it with the REAL worker
// processor (imported from @twenty4/worker) and asserts the DB rows + S3 objects are
// provably GONE. If the API's payload field names ever disagree with what the worker
// parses, the contract schema parse throws here (the +drift-guard test proves it).
//
// Isolated queue names (`-drain-test-<pid>-<seq>`) so no running prod worker steals
// the enqueues; delay 0 so the job is immediately retrievable.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import {
  deleteMontageJobId,
  expireMontageJobId,
  purgeAccountJobId,
  rawPurgeJobId,
  resolveDayBucket,
  type Env,
} from "@twenty4/contracts";
import {
  auditLog,
  comment,
  dailyMediaItem,
  montage,
  reaction,
  user,
} from "@twenty4/contracts/db";
import {
  createWorkerDb,
  createWorkerS3,
  deleteObjectIdempotent,
  processDeleteMontage,
  processExpireMontage,
  processPurgeAccount,
  processRawPurge,
  type CleanupDeps,
} from "@twenty4/worker";
import type { WorkerDb } from "@twenty4/worker";
import {
  closeCleanupQueues,
  createCleanupQueues,
  enqueueDeleteMontage,
  enqueueExpireMontage,
  enqueuePurgeAccount,
  enqueueRawPurge,
  type CleanupQueues,
} from "../src/cleanup/queue.ts";
import { makeMontageEnv } from "./montageHelpers.ts";

const env: Env = makeMontageEnv();
let db: WorkerDb;
let s3: ReturnType<typeof createWorkerS3>;
let deps: CleanupDeps;
let queues: CleanupQueues;

const userIds: string[] = [];
const tracked: { bucket: string; key: string }[] = [];
const DAY = resolveDayBucket(new Date(), "UTC");
const hoursAhead = (h: number) => new Date(Date.now() + h * 3_600_000);

beforeAll(() => {
  db = createWorkerDb(env.DATABASE_URL);
  s3 = createWorkerS3(env);
  deps = { db, s3, env };
  // Unique suffix → an isolated set of queues no running prod worker drains.
  queues = createCleanupQueues(env.REDIS_URL, `-drain-test-${process.pid}-${Date.now()}`);
});

afterAll(async () => {
  for (const t of tracked) await deleteObjectIdempotent(s3, t.bucket, t.key).catch(() => {});
  for (const uid of userIds) {
    await db.sql`DELETE FROM audit_log WHERE actor_id = ${uid}`.catch(() => {});
    await db.sql`DELETE FROM "user" WHERE id = ${uid}`.catch(() => {});
  }
  for (const q of [queues.expireMontage, queues.rawPurge, queues.purgeAccount, queues.deleteMontage]) {
    await q.obliterate({ force: true }).catch(() => {});
  }
  await closeCleanupQueues(queues);
  await db.sql.end({ timeout: 5 });
});

// ── seed helpers (DB rows + REAL S3 objects, so "gone" is provable) ──────────────
async function seedUser(): Promise<string> {
  const phone = `+1789${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
  const ins = await db.db.insert(user).values({ phone, timezone: "UTC" }).returning({ id: user.id });
  const id = ins[0]!.id;
  userIds.push(id);
  return id;
}

async function putObj(bucket: string, key: string): Promise<void> {
  await s3.client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(`drain-${key}`), ContentType: "application/octet-stream" }),
  );
  tracked.push({ bucket, key });
}

async function objExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (name === "NotFound" || name === "NoSuchKey" || status === 404) return false;
    throw err;
  }
}

// A published montage row + its real video (montages bucket) + thumb (thumbnails).
async function seedMontage(userId: string): Promise<{ id: string; videoKey: string; thumbKey: string }> {
  const id = randomUUID();
  const videoKey = `montages/${userId}/${id}`;
  const thumbKey = `thumbnails/${userId}/montage-${id}`;
  await putObj(s3.montagesBucket, videoKey);
  await putObj(s3.thumbnailsBucket, thumbKey);
  await db.db.insert(montage).values({
    id,
    userId,
    dayBucket: DAY,
    status: "published",
    theme: "clean",
    musicId: "clean",
    videoPath: videoKey,
    thumbnailPath: thumbKey,
    publishedAt: new Date(),
    expiryAt: hoursAhead(2),
  });
  return { id, videoKey, thumbKey };
}

async function seedRaw(userId: string): Promise<{ id: string; storageKey: string }> {
  const id = randomUUID();
  const storageKey = `media/${userId}/${id}`;
  await putObj(s3.rawBucket, storageKey);
  await db.db.insert(dailyMediaItem).values({
    id,
    userId,
    dayBucket: DAY,
    mediaType: "photo",
    storagePath: storageKey,
    validationStatus: "valid",
    processingStatus: "valid",
  });
  return { id, storageKey };
}

const seedReaction = (montageId: string, userId: string) =>
  db.db.insert(reaction).values({ montageId, userId, type: "like" });
const seedComment = (montageId: string, userId: string) =>
  db.db.insert(comment).values({ montageId, userId, text: "drain test comment" });

const montageExists = async (id: string) =>
  (await db.db.select({ id: montage.id }).from(montage).where(eq(montage.id, id)).limit(1)).length > 0;
const countRaw = async (userId: string) =>
  (await db.db.select({ id: dailyMediaItem.id }).from(dailyMediaItem).where(eq(dailyMediaItem.userId, userId))).length;
const countReactions = async (montageId: string) =>
  (await db.db.select({ id: reaction.id }).from(reaction).where(eq(reaction.montageId, montageId))).length;
const countComments = async (montageId: string) =>
  (await db.db.select({ id: comment.id }).from(comment).where(eq(comment.montageId, montageId))).length;
const tombstoneReasons = async (targetId: string) =>
  (await db.db.select({ metadata: auditLog.metadata }).from(auditLog).where(eq(auditLog.targetId, targetId))).map(
    (r) => (r.metadata as { reason?: string }).reason,
  );

// ─────────────────────────────────────────────────────────────────────────────
describe("API enqueue → real worker processor drain (one-shot jobs)", () => {
  test("expire-montage: API-enqueued job drains to row + S3 video/thumb gone", async () => {
    const owner = await seedUser();
    const m = await seedMontage(owner);
    await seedReaction(m.id, owner);

    // Enqueue with the API's REAL helper (delay 0 → immediately retrievable).
    await enqueueExpireMontage(queues, m.id, 0);
    const job = await queues.expireMontage.getJob(expireMontageJobId(m.id));
    expect(job).toBeTruthy();

    // Drain the REAL (Redis-round-tripped) job.data through the REAL worker processor.
    const res = await processExpireMontage(deps, job!.data);
    expect(res.deleted).toBe(true);

    expect(await montageExists(m.id)).toBe(false);
    expect(await countReactions(m.id)).toBe(0);
    expect(await objExists(s3.montagesBucket, m.videoKey)).toBe(false);
    expect(await objExists(s3.thumbnailsBucket, m.thumbKey)).toBe(false);
    expect(await tombstoneReasons(m.id)).toContain("expired");
  });

  test("raw-purge: API-enqueued job drains to daily_media_item rows + S3 objects gone", async () => {
    const owner = await seedUser();
    const a = await seedRaw(owner);
    const b = await seedRaw(owner);
    expect(await countRaw(owner)).toBe(2);

    const montageId = randomUUID(); // raw-purge jobId is keyed on montage+day (worker ignores the id)
    await enqueueRawPurge(queues, { montageId, dayBucket: DAY, userId: owner, delayMs: 0 });
    const job = await queues.rawPurge.getJob(rawPurgeJobId(montageId, DAY));
    expect(job).toBeTruthy();
    // The load-bearing fields survived the round-trip with the names the worker reads.
    expect((job!.data as { userId: string; dayBucket: string }).userId).toBe(owner);
    expect((job!.data as { dayBucket: string }).dayBucket).toBe(DAY);

    const res = await processRawPurge(deps, job!.data);
    expect(res.rows).toBe(2);

    expect(await countRaw(owner)).toBe(0);
    expect(await objExists(s3.rawBucket, a.storageKey)).toBe(false);
    expect(await objExists(s3.rawBucket, b.storageKey)).toBe(false);
  });

  test("purge-account: API-enqueued job cascades owner's montage/raw/footprint; others survive; account deleted", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const own = await seedMontage(owner);
    const ownRaw = await seedRaw(owner);
    const others = await seedMontage(other);
    await seedReaction(others.id, owner); // owner's footprint on another's montage
    await seedComment(others.id, owner);

    await enqueuePurgeAccount(queues, owner);
    const job = await queues.purgeAccount.getJob(purgeAccountJobId(owner));
    expect(job).toBeTruthy();

    const res = await processPurgeAccount(deps, job!.data);
    expect(res.montages).toBe(1);
    expect(res.reactionsOnOthers).toBe(1);
    expect(res.commentsOnOthers).toBe(1);

    // Owner's content + objects gone.
    expect(await montageExists(own.id)).toBe(false);
    expect(await countRaw(owner)).toBe(0);
    expect(await objExists(s3.montagesBucket, own.videoKey)).toBe(false);
    expect(await objExists(s3.rawBucket, ownRaw.storageKey)).toBe(false);
    // Other's montage survives; owner's footprint on it is gone.
    expect(await montageExists(others.id)).toBe(true);
    expect(await countReactions(others.id)).toBe(0);
    expect(await countComments(others.id)).toBe(0);
    // Account flipped to deleted.
    const acct = await db.db.select({ s: user.accountStatus }).from(user).where(eq(user.id, owner));
    expect(acct[0]!.s).toBe("deleted");
  });

  test("delete-montage: API-enqueued job (reason carried) drains to row + S3 gone, tombstone reason preserved", async () => {
    const owner = await seedUser();
    const m = await seedMontage(owner);
    await seedComment(m.id, owner);

    await enqueueDeleteMontage(queues, m.id, "deleted_by_user");
    const job = await queues.deleteMontage.getJob(deleteMontageJobId(m.id));
    expect(job).toBeTruthy();
    expect((job!.data as { reason: string }).reason).toBe("deleted_by_user");

    const res = await processDeleteMontage(deps, job!.data);
    expect(res.deleted).toBe(true);

    expect(await montageExists(m.id)).toBe(false);
    expect(await countComments(m.id)).toBe(0);
    expect(await objExists(s3.montagesBucket, m.videoKey)).toBe(false);
    // The optional `reason` field round-tripped end-to-end into the tombstone.
    expect(await tombstoneReasons(m.id)).toContain("deleted_by_user");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole reason this suite exists: prove a field-name drift FAILS LOUDLY at the
// contract parse boundary instead of silently reading `undefined` and no-op'ing.
describe("drift guard — a renamed/missing payload field is REJECTED at parse", () => {
  const someUuid = "11111111-1111-4111-8111-111111111111";
  test("each processor throws on the wrong field names (would-be silent prod no-op)", async () => {
    await expect(processExpireMontage(deps, { recapId: someUuid })).rejects.toThrow();
    await expect(processRawPurge(deps, { user: someUuid, bucket: DAY })).rejects.toThrow();
    await expect(processPurgeAccount(deps, { accountId: someUuid })).rejects.toThrow();
    await expect(processDeleteMontage(deps, { id: someUuid })).rejects.toThrow();
  });
});
