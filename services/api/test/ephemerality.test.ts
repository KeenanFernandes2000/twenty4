// M9 ephemerality — API-side live-stack tests (real Postgres + Redis + MinIO).
// Covers the API surface this agent owns: the publish-time enqueue wiring (delayed
// expire-montage + raw-purge with correct delays + ':'-free jobIds), the new
// replace / delete / download-url routes + their owner-guards + the supersede
// contract, the DELETE /users/me purge enqueue, and the thin admin guard/shape.
// The actual deletion (rows + S3 gone) is the WORKER agent's §6 gate; here we
// assert the ENQUEUE happened + the synchronous DB bookkeeping (superseded_by,
// account_status, session revoke). The injected cleanup queues use isolated names
// so no running worker drains the enqueues under inspection.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { auditLog, comment, montage, reaction, session as sessionTable, user } from "@twenty4/contracts/db";
import {
  deleteMontageJobId,
  expireMontageJobId,
  purgeAccountJobId,
  rawPurgeJobId,
} from "@twenty4/contracts";
import type { Queue } from "bullmq";
import { buildApp } from "../src/app.ts";
import { createCleanupQueues, type CleanupQueues } from "../src/cleanup/queue.ts";
import { renderMontageJobId, type RenderMontageJobData } from "../src/montage/queue.ts";
import type { DbClient } from "../src/db.ts";
import type { RedisClient } from "../src/redis.ts";
import {
  bearer,
  cleanupByPhones,
  createGroup,
  makeMontageDb,
  makeMontageEnv,
  makeMontageQueue,
  makeMontageRedis,
  seedMontage,
  seedUsers,
  seedValidMedia,
  todayBucket,
} from "./montageHelpers.ts";
import { addMemberDirect, seedComment } from "./feedHelpers.ts";

// 2h expiry / 5-min raw grace → deterministic delay assertions (the env-shortened
// "24h" contract; the worker runs the real second-scale expiry gate).
const EXPIRY_HOURS = 2;
const RAW_GRACE_MIN = 5;
const env = makeMontageEnv({ MONTAGE_EXPIRY_HOURS: String(EXPIRY_HOURS), RAW_PURGE_GRACE_MIN: String(RAW_GRACE_MIN) });
const EXPIRY_MS = EXPIRY_HOURS * 60 * 60 * 1000;
const RAW_GRACE_MS = RAW_GRACE_MIN * 60 * 1000;
const MIN = env.MONTAGE_MIN_MEDIA;

let app: FastifyInstance;
let db: DbClient;
let redis: RedisClient;
let renderQueue: Queue<RenderMontageJobData>;
let cleanup: CleanupQueues;

const N = Date.now().toString().slice(-7);
const OWNER = `+1730${N}`;
const STRANGER = `+1731${N}`;
const DELETER = `+1732${N}`;
const ADMIN = `+1733${N}`;
const ALL_PHONES = [OWNER, STRANGER, DELETER, ADMIN];

let owner: { token: string; userId: string };
let stranger: { token: string; userId: string };
let admin: { token: string; userId: string };
let groupId: string;

beforeAll(async () => {
  db = makeMontageDb();
  redis = makeMontageRedis();
  renderQueue = makeMontageQueue(env);
  cleanup = createCleanupQueues(env.REDIS_URL, `-test-${process.pid}-${Date.now()}`);
  await cleanupByPhones(db, ALL_PHONES);
  app = await buildApp({ db, redis, env, nodeEnv: "test", montageQueue: renderQueue, cleanupQueues: cleanup });
  await app.ready();
  const seeded = await seedUsers(app, [OWNER, STRANGER, ADMIN]);
  owner = { token: seeded[0]!.token, userId: seeded[0]!.userId };
  stranger = { token: seeded[1]!.token, userId: seeded[1]!.userId };
  admin = { token: seeded[2]!.token, userId: seeded[2]!.userId };
  // Promote the admin user (is_admin column drives the thin-admin guard).
  await db.db.update(user).set({ isAdmin: true }).where(eq(user.id, admin.userId));
  groupId = await createGroup(app, owner.token, "ephemerality crew");
  await addMemberDirect(db, groupId, stranger.userId, "member");
  await seedValidMedia(db, owner.userId, MIN);
});

afterAll(async () => {
  await cleanupByPhones(db, ALL_PHONES);
  await app.close();
  await renderQueue.close();
  for (const q of [cleanup.expireMontage, cleanup.rawPurge, cleanup.purgeAccount, cleanup.deleteMontage]) {
    await q.obliterate({ force: true }).catch(() => {});
    await q.close();
  }
  await db.sql.end({ timeout: 5 });
  await redis.quit();
});

function post(url: string, token: string, body?: unknown) {
  return app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...bearer(token) }, payload: JSON.stringify(body ?? {}) });
}
function del(url: string, token: string) {
  return app.inject({ method: "DELETE", url, headers: bearer(token) });
}
function get(url: string, token: string) {
  return app.inject({ method: "GET", url, headers: bearer(token) });
}

// Reset the owner's montages between tests (media stays seeded).
async function resetOwner(): Promise<void> {
  await db.sql`DELETE FROM montage WHERE user_id = ${owner.userId}`;
}

// Seed a draft_ready montage (a renderable recap), then publish it to the group.
async function seedAndPublish(args: { dayBucket?: string } = {}): Promise<string> {
  const id = await seedMontage(db, {
    userId: owner.userId,
    status: "draft_ready",
    dayBucket: args.dayBucket ?? todayBucket(),
    videoPath: `montages/${owner.userId}/${Math.random().toString(36).slice(2)}`,
    thumbnailPath: `thumbnails/${owner.userId}/poster`,
    durationMs: 30000,
  });
  const res = await post(`/montages/${id}/publish`, owner.token, { groupIds: [groupId] });
  if (res.statusCode !== 200) throw new Error(`publish failed: ${res.statusCode} ${res.body}`);
  return id;
}

// ── 1. Publish enqueues delayed expire-montage + raw-purge (correct delays, no ':') ─
describe("publish-time enqueue wiring", () => {
  test("first publish arms a delayed expire + raw-purge job with correct delays + ':'-free jobIds", async () => {
    await resetOwner();
    const id = await seedAndPublish();

    const expireJob = await cleanup.expireMontage.getJob(expireMontageJobId(id));
    expect(expireJob).toBeTruthy();
    expect(expireJob!.id).toBe(expireMontageJobId(id));
    expect(expireJob!.id).not.toContain(":");
    // Delay ≈ EXPIRY_MS (computed as expiry_at - now at enqueue; a few ms of slack).
    expect(expireJob!.opts.delay!).toBeLessThanOrEqual(EXPIRY_MS);
    expect(expireJob!.opts.delay!).toBeGreaterThan(EXPIRY_MS - 10_000);
    expect(await expireJob!.getState()).toBe("delayed");

    const rawJob = await cleanup.rawPurge.getJob(rawPurgeJobId(id, todayBucket()));
    expect(rawJob).toBeTruthy();
    expect(rawJob!.id).not.toContain(":");
    expect(rawJob!.opts.delay).toBe(RAW_GRACE_MS);
    expect((rawJob!.data as { userId: string }).userId).toBe(owner.userId);

    // expiry_at = published_at + EXPIRY_HOURS (env-driven, not hardcoded 24h).
    const [row] = await db.db.select().from(montage).where(eq(montage.id, id));
    const span = row!.expiryAt!.getTime() - row!.publishedAt!.getTime();
    expect(span).toBe(EXPIRY_MS);
  });

  test("idempotent re-publish does NOT re-arm (same jobId dedups, timestamps unchanged)", async () => {
    await resetOwner();
    const id = await seedAndPublish();
    const [before] = await db.db.select().from(montage).where(eq(montage.id, id));
    const res = await post(`/montages/${id}/publish`, owner.token, { groupIds: [groupId] });
    expect(res.statusCode).toBe(200);
    const [after] = await db.db.select().from(montage).where(eq(montage.id, id));
    expect(after!.expiryAt!.getTime()).toBe(before!.expiryAt!.getTime());
  });
});

// ── 2. Replace E2E — supersede set, prior delete enqueued on successor publish ──
describe("POST /montages/:id/replace", () => {
  test("replace then publish B → A superseded + delete-A enqueued + A expire cancelled + B live", async () => {
    await resetOwner();
    const a = await seedAndPublish();
    // A's reactions + comments (the children the worker cascades; here just present).
    await db.db.insert(reaction).values({ montageId: a, userId: stranger.userId, type: "fire" });
    await seedComment(db, { montageId: a, userId: stranger.userId, text: "love it" });
    expect(await cleanup.expireMontage.getJob(expireMontageJobId(a))).toBeTruthy();

    // Replace → new montage B generating; A.superseded_by = B set immediately.
    const repRes = await post(`/montages/${a}/replace`, owner.token, {});
    expect(repRes.statusCode).toBe(202);
    const b = repRes.json().montageId as string;
    expect(repRes.json().status).toBe("generating");
    expect(b).not.toBe(a);
    const [aRow] = await db.db.select().from(montage).where(eq(montage.id, a));
    expect(aRow!.supersededBy).toBe(b);
    expect(aRow!.status).toBe("published"); // prior STAYS live until B publishes
    // B render enqueued (reuses the generate pipeline).
    expect(await renderQueue.getJob(renderMontageJobId(b))).toBeTruthy();

    // Simulate B's render completing, then publish B into the same group.
    await db.db.update(montage).set({ status: "draft_ready", videoPath: `montages/${owner.userId}/b` }).where(eq(montage.id, b));
    const pubB = await post(`/montages/${b}/publish`, owner.token, { groupIds: [groupId] });
    expect(pubB.statusCode).toBe(200); // NOT a one-recap clash (A is superseded by B)

    // On B's publish: A is hard-delete-enqueued (reason 'replaced') + A's expire cancelled.
    const delA = await cleanup.deleteMontage.getJob(deleteMontageJobId(a));
    expect(delA).toBeTruthy();
    expect((delA!.data as { reason: string }).reason).toBe("replaced");
    expect(await cleanup.expireMontage.getJob(expireMontageJobId(a))).toBeFalsy();
    // B is live with its OWN expiry + expire job.
    expect(await cleanup.expireMontage.getJob(expireMontageJobId(b))).toBeTruthy();
    const [bRow] = await db.db.select().from(montage).where(eq(montage.id, b));
    expect(bRow!.status).toBe("published");
    expect(bRow!.expiryAt).toBeTruthy();
  });

  test("double-replace returns the still-alive successor (idempotent, no second spawn)", async () => {
    await resetOwner();
    const a = await seedAndPublish();
    const first = await post(`/montages/${a}/replace`, owner.token, {});
    const b1 = first.json().montageId as string;
    const second = await post(`/montages/${a}/replace`, owner.token, {});
    expect(second.statusCode).toBe(202);
    expect(second.json().montageId).toBe(b1); // same successor, not a new one
    const count = await db.db.select().from(montage).where(eq(montage.userId, owner.userId));
    expect(count.length).toBe(2); // A + B1 only
  });

  test("replace is owner-guarded (stranger → 404) and rejects a non-published montage (409)", async () => {
    await resetOwner();
    const a = await seedAndPublish();
    expect((await post(`/montages/${a}/replace`, stranger.token, {})).statusCode).toBe(404);
    const draft = await seedMontage(db, { userId: owner.userId, status: "draft_ready", dayBucket: "2020-01-01", videoPath: "x" });
    expect((await post(`/montages/${draft}/replace`, owner.token, {})).statusCode).toBe(409);
  });
});

// ── 3. DELETE /montages/:id — enqueue delete-montage + owner-guard ─────────────
describe("DELETE /montages/:id", () => {
  test("owner delete → 202 {deleting} + delete-montage enqueued (reason deleted_by_user)", async () => {
    await resetOwner();
    const id = await seedAndPublish();
    const res = await del(`/montages/${id}`, owner.token);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("deleting");
    const job = await cleanup.deleteMontage.getJob(deleteMontageJobId(id));
    expect(job).toBeTruthy();
    expect(job!.id).not.toContain(":");
    expect((job!.data as { reason: string }).reason).toBe("deleted_by_user");
  });

  test("non-owner → 404, missing → 404 (no existence leak)", async () => {
    await resetOwner();
    const id = await seedAndPublish();
    expect((await del(`/montages/${id}`, stranger.token)).statusCode).toBe(404);
    expect((await del(`/montages/00000000-0000-4000-8000-000000000000`, owner.token)).statusCode).toBe(404);
  });
});

// ── 4. DELETE /users/me — purge enqueue + session revoke + status flip ─────────
describe("DELETE /users/me", () => {
  test("enqueues purge-account, revokes sessions, sets account_status=deleted", async () => {
    const seeded = await seedUsers(app, [DELETER]);
    const u = { token: seeded[0]!.token, userId: seeded[0]!.userId };
    await seedMontage(db, { userId: u.userId, status: "published", videoPath: "x", publishedAt: new Date(), expiryAt: new Date(Date.now() + EXPIRY_MS) });

    const res = await del("/users/me", u.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("deleted");

    const job = await cleanup.purgeAccount.getJob(purgeAccountJobId(u.userId));
    expect(job).toBeTruthy();
    expect(job!.id).not.toContain(":");
    const [row] = await db.db.select().from(user).where(eq(user.id, u.userId));
    expect(row!.accountStatus).toBe("deleted");
    const sessions = await db.db.select().from(sessionTable).where(eq(sessionTable.userId, u.userId));
    expect(sessions.length).toBe(0);
  });
});

// ── 5. GET /montages/:id/download-url — clamp + post-expiry 404 ────────────────
describe("GET /montages/:id/download-url", () => {
  test("TTL clamped to remaining lifetime (never exceeds it)", async () => {
    await resetOwner();
    const id = await seedMontage(db, {
      userId: owner.userId,
      status: "published",
      videoPath: `montages/${owner.userId}/clamp`,
      publishedAt: new Date(),
      expiryAt: new Date(Date.now() + 120_000), // 120s remaining < 900s default TTL
    });
    const res = await get(`/montages/${id}/download-url`, owner.token);
    expect(res.statusCode).toBe(200);
    const ttl = res.json().expiresInSec as number;
    expect(ttl).toBeLessThanOrEqual(120);
    expect(ttl).toBeLessThan(env.MEDIA_DOWNLOAD_URL_TTL_SEC); // proves the clamp bit
  });

  test("post-expiry → 404 (a leaked URL dies with the content)", async () => {
    await resetOwner();
    const id = await seedMontage(db, {
      userId: owner.userId,
      status: "published",
      videoPath: `montages/${owner.userId}/gone`,
      publishedAt: new Date(Date.now() - EXPIRY_MS),
      expiryAt: new Date(Date.now() - 1000), // already expired
    });
    const res = await get(`/montages/${id}/download-url`, owner.token);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("MONTAGE_NOT_FOUND");
  });

  test("non-owner → 404", async () => {
    await resetOwner();
    const id = await seedAndPublish();
    expect((await get(`/montages/${id}/download-url`, stranger.token)).statusCode).toBe(404);
  });
});

// ── 5b. GET /montages/:id poll DTO — no 1s self-preview leak past expiry ───────
describe("GET /montages/:id (poll DTO) post-expiry preview clamp", () => {
  test("owner polling an expired-but-unswept montage gets previewUrl + thumbnailUrl null (no presign)", async () => {
    await resetOwner();
    const id = await seedMontage(db, {
      userId: owner.userId,
      status: "published",
      videoPath: `montages/${owner.userId}/expired-poll`,
      thumbnailPath: `thumbnails/${owner.userId}/expired-poll`,
      publishedAt: new Date(Date.now() - EXPIRY_MS),
      expiryAt: new Date(Date.now() - 1000), // already expired, not yet swept
    });
    const res = await get(`/montages/${id}`, owner.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("published");
    expect(body.previewUrl).toBeNull(); // was a clamped 1s presign before the fix
    expect(body.thumbnailUrl).toBeNull();
  });

  test("owner polling a still-live published montage still gets a previewUrl", async () => {
    await resetOwner();
    const id = await seedMontage(db, {
      userId: owner.userId,
      status: "published",
      videoPath: `montages/${owner.userId}/live-poll`,
      publishedAt: new Date(),
      expiryAt: new Date(Date.now() + EXPIRY_MS), // plenty of lifetime left
    });
    const res = await get(`/montages/${id}`, owner.token);
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().previewUrl).toBe("string");
  });
});

// ── 7. MONTAGE_EXPIRY_SEC override — sub-hour expiry WINS over HOURS (spec §7/§8) ─
// A dedicated app wired with MONTAGE_EXPIRY_SEC set (HOURS left at the 24h default)
// so the REAL publish path computes expiry_at = published_at + that many SECONDS,
// enabling the ~2-min on-device lifetime + the "24h expiry in seconds" demo. Own
// db/redis/queues (isolated names) so its enqueues sit untouched for inspection.
describe("MONTAGE_EXPIRY_SEC override (sub-hour expiry, precedence over HOURS)", () => {
  const EXPIRY_SEC = 120; // 2 min — well under the 1h HOURS floor it overrides
  const secEnv = makeMontageEnv({ MONTAGE_EXPIRY_SEC: String(EXPIRY_SEC) }); // HOURS stays 24 (default)
  const SEC_MS = EXPIRY_SEC * 1000;
  const SEC_OWNER = `+1734${N}`;
  let secApp: FastifyInstance;
  let secDb: DbClient;
  let secRedis: RedisClient;
  let secRender: Queue<RenderMontageJobData>;
  let secCleanup: CleanupQueues;
  let secOwner: { token: string; userId: string };
  let secGroup: string;

  beforeAll(async () => {
    secDb = makeMontageDb();
    secRedis = makeMontageRedis();
    secRender = makeMontageQueue(secEnv);
    secCleanup = createCleanupQueues(secEnv.REDIS_URL, `-sec-${process.pid}-${Date.now()}`);
    await cleanupByPhones(secDb, [SEC_OWNER]);
    secApp = await buildApp({ db: secDb, redis: secRedis, env: secEnv, nodeEnv: "test", montageQueue: secRender, cleanupQueues: secCleanup });
    await secApp.ready();
    const [seeded] = await seedUsers(secApp, [SEC_OWNER]);
    secOwner = { token: seeded!.token, userId: seeded!.userId };
    secGroup = await createGroup(secApp, secOwner.token, "sec-expiry crew");
    await seedValidMedia(secDb, secOwner.userId, MIN);
  });

  afterAll(async () => {
    await cleanupByPhones(secDb, [SEC_OWNER]);
    await secApp.close();
    await secRender.close();
    for (const q of [secCleanup.expireMontage, secCleanup.rawPurge, secCleanup.purgeAccount, secCleanup.deleteMontage]) {
      await q.obliterate({ force: true }).catch(() => {});
      await q.close();
    }
    await secDb.sql.end({ timeout: 5 });
    await secRedis.quit();
    // This block boots a 2ND app on the SHARED DB; buildApp's reconcileAdmins (empty
    // ADMIN_EMAILS) demotes every is_admin row → restore the outer block's admin so
    // the thin-admin tests still see is_admin=true regardless of describe ordering.
    await db.db.update(user).set({ isAdmin: true }).where(eq(user.id, admin.userId));
  });

  test("expiry_at = published_at + MONTAGE_EXPIRY_SEC (wins over 24h HOURS) + armed expire delay reflects it", async () => {
    const id = await seedMontage(secDb, {
      userId: secOwner.userId,
      status: "draft_ready",
      dayBucket: todayBucket(),
      videoPath: `montages/${secOwner.userId}/sec`,
      thumbnailPath: `thumbnails/${secOwner.userId}/sec`,
      durationMs: 30000,
    });
    const res = await secApp.inject({
      method: "POST",
      url: `/montages/${id}/publish`,
      headers: { "content-type": "application/json", ...bearer(secOwner.token) },
      payload: JSON.stringify({ groupIds: [secGroup] }),
    });
    expect(res.statusCode).toBe(200);

    // expiry_at ≈ published_at + SEC (NOT + 24h) — the SEC override takes precedence.
    const [row] = await secDb.db.select().from(montage).where(eq(montage.id, id));
    const span = row!.expiryAt!.getTime() - row!.publishedAt!.getTime();
    expect(span).toBe(SEC_MS);
    expect(span).toBeLessThan(60 * 60 * 1000); // proves it is NOT the 24h HOURS default

    // The armed expire job's delay reflects the SEC span (derived from expiry_at - now).
    const job = await secCleanup.expireMontage.getJob(expireMontageJobId(id));
    expect(job).toBeTruthy();
    expect(job!.id).not.toContain(":");
    expect(job!.opts.delay!).toBeLessThanOrEqual(SEC_MS);
    expect(job!.opts.delay!).toBeGreaterThan(SEC_MS - 10_000);
    expect(await job!.getState()).toBe("delayed");
  });
});

// ── 6. Thin admin — admin-guarded, read-only shape ────────────────────────────
describe("thin admin (read-only)", () => {
  test("GET /admin/cleanup-jobs: admin 200 + shape, non-admin 403", async () => {
    const ok = await get("/admin/cleanup-jobs", admin.token);
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json().queues)).toBe(true);
    const forbidden = await get("/admin/cleanup-jobs", owner.token);
    expect(forbidden.statusCode).toBe(403);
  });

  test("GET /admin/storage-usage: admin 200 + counts, non-admin 403", async () => {
    const ok = await get("/admin/storage-usage", admin.token);
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(typeof body.liveMontages).toBe("number");
    expect(typeof body.publishedMontages).toBe("number");
    expect((await get("/admin/storage-usage", stranger.token)).statusCode).toBe(403);
  });

  test("admin-action audit goes through the sanitize chokepoint + stores a HASHED ip, never a raw ip", async () => {
    await get("/admin/storage-usage", admin.token); // writes one admin.storage_usage audit row
    const rows = await db.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.actorId, admin.userId));
    const adminRows = rows
      .map((r) => r.metadata as Record<string, unknown>)
      .filter((m) => m.action === "admin.storage_usage");
    expect(adminRows.length).toBeGreaterThanOrEqual(1);
    for (const m of adminRows) {
      // sanitizer pins `action`; the ip is hashed (or null), never raw at rest.
      expect(m.action).toBe("admin.storage_usage");
      expect("ip" in m).toBe(false); // no raw ip key
      expect(typeof m.ipHash === "string" || m.ipHash === null).toBe(true);
      if (typeof m.ipHash === "string") {
        expect(m.ipHash).toMatch(/^[0-9a-f]+$/); // short sha256 hex, not the literal ip
        expect(m.ipHash).not.toContain(".");
      }
    }
  });
});
