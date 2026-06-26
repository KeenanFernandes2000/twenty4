// M7 montage routes — live-stack integration tests (§7). Real Postgres + Redis +
// MinIO. Covers: generate (202 + row + enqueue + jobId), NOT_ENOUGH_MEDIA floor,
// concurrent generate → one in-flight, find-or-create idempotency, mediaIds honor,
// GET owner-only 404 + preview-only-when-ready, options feed, regenerate
// concurrency guard, publish (member writes visibility + published/expiry), publish
// non-member 403, idempotent re-publish, one-recap-per-group/day, publish
// precondition (409), and unauthenticated 401.
//
// The real render is the worker agent's gate; montage rows are seeded directly in
// the needed statuses here. The injected render-montage queue has a unique name no
// prod worker drains, so enqueues sit for inspection.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { montage, montageGroupVisibility } from "@twenty4/contracts/db";
import type { Queue } from "bullmq";
import type { DbClient } from "../src/db.ts";
import type { RedisClient } from "../src/redis.ts";
import type { RenderMontageJobData } from "../src/montage/queue.ts";
import { renderMontageJobId } from "../src/montage/queue.ts";
import {
  bearer,
  buildMontageApp,
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

let app: FastifyInstance;
let db: DbClient;
let redis: RedisClient;
let queue: Queue<RenderMontageJobData>;
const env = makeMontageEnv(); // MONTAGE_MIN_MEDIA defaults to 3
const MIN = env.MONTAGE_MIN_MEDIA;

const N = Date.now().toString().slice(-7);
const OWNER = `+1720${N}`;
const STRANGER = `+1721${N}`;
const ALL_PHONES = [OWNER, STRANGER];

let owner: { token: string; userId: string };
let stranger: { token: string; userId: string };

beforeAll(async () => {
  db = makeMontageDb();
  redis = makeMontageRedis();
  queue = makeMontageQueue(env);
  await cleanupByPhones(db, ALL_PHONES);
  app = await buildMontageApp({ db, redis, env, queue });
  const seeded = await seedUsers(app, [OWNER, STRANGER]);
  owner = seeded[0]!;
  stranger = seeded[1]!;
});

afterAll(async () => {
  await cleanupByPhones(db, ALL_PHONES);
  await app.close();
  await queue.close();
  await db.sql.end({ timeout: 5 });
  await redis.quit();
});

// Wipe the owner's montages + media between tests so find-or-create starts clean.
async function resetOwner(userId: string): Promise<void> {
  await db.sql`DELETE FROM montage WHERE user_id = ${userId}`;
  await db.sql`DELETE FROM daily_media_item WHERE user_id = ${userId}`;
}

function post(url: string, token: string, body?: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...bearer(token) },
    payload: JSON.stringify(body ?? {}),
  });
}
function get(url: string, token: string) {
  return app.inject({ method: "GET", url, headers: bearer(token) });
}

async function montageRowsFor(userId: string) {
  return db.db.select().from(montage).where(eq(montage.userId, userId));
}

// ── 1. POST /montages — 202 + row + enqueue + jobId ──────────────────────────
describe("POST /montages — generate", () => {
  test("≥ floor valid media ⇒ 202 generating + one row + enqueued under jobId (no ':')", async () => {
    await resetOwner(owner.userId);
    const ids = await seedValidMedia(db, owner.userId, MIN);

    const res = await post("/montages", owner.token);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("generating");
    expect(typeof body.montageId).toBe("string");

    const rows = await montageRowsFor(owner.userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(body.montageId);
    expect(rows[0]!.status).toBe("generating");
    expect(String(rows[0]!.dayBucket)).toBe(todayBucket());
    expect([...rows[0]!.sourceMediaIds].sort()).toEqual([...ids].sort());
    expect(rows[0]!.renderJobId).toBe(renderMontageJobId(body.montageId));

    // Enqueued exactly once under the deterministic jobId (no ':' — §8.10 guard).
    const jobId = renderMontageJobId(body.montageId);
    expect(jobId).not.toContain(":");
    const job = await queue.getJob(jobId);
    expect(job?.id).toBe(jobId);
    expect((job?.data as RenderMontageJobData).montageId).toBe(body.montageId);
  });

  test("fewer than the floor ⇒ 422 NOT_ENOUGH_MEDIA, no row", async () => {
    await resetOwner(owner.userId);
    await seedValidMedia(db, owner.userId, MIN - 1);
    const res = await post("/montages", owner.token);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("NOT_ENOUGH_MEDIA");
    expect((await montageRowsFor(owner.userId)).length).toBe(0);
  });

  test("mediaIds subset honored: sourceMediaIds = the intersection of valid+today", async () => {
    await resetOwner(owner.userId);
    const ids = await seedValidMedia(db, owner.userId, MIN + 2);
    const subset = ids.slice(0, MIN);
    // include a bogus id that is NOT valid/owned — it must be ignored, not error.
    const res = await post("/montages", owner.token, {
      mediaIds: [...subset, "00000000-0000-0000-0000-000000000000"],
    });
    expect(res.statusCode).toBe(202);
    const rows = await montageRowsFor(owner.userId);
    expect([...rows[0]!.sourceMediaIds].sort()).toEqual([...subset].sort());
  });

  test("idempotent: a 2nd generate while one exists returns the SAME row, no 2nd row", async () => {
    await resetOwner(owner.userId);
    await seedValidMedia(db, owner.userId, MIN);
    const first = await post("/montages", owner.token);
    const firstId = first.json().montageId;
    const second = await post("/montages", owner.token);
    expect(second.statusCode).toBe(202);
    expect(second.json().montageId).toBe(firstId);
    expect((await montageRowsFor(owner.userId)).length).toBe(1);
  });

  test("concurrent generate ⇒ exactly ONE in-flight row + ONE enqueue", async () => {
    await resetOwner(owner.userId);
    await seedValidMedia(db, owner.userId, MIN);

    let adds = 0;
    const origAdd = queue.add.bind(queue);
    (queue as unknown as { add: typeof origAdd }).add = (async (name, data, opts) => {
      adds += 1;
      return origAdd(name, data, opts);
    }) as typeof origAdd;
    try {
      const [a, b] = await Promise.all([post("/montages", owner.token), post("/montages", owner.token)]);
      expect(a.statusCode).toBe(202);
      expect(b.statusCode).toBe(202);
      expect(a.json().montageId).toBe(b.json().montageId);
      expect((await montageRowsFor(owner.userId)).length).toBe(1);
      expect(adds).toBe(1);
    } finally {
      (queue as unknown as { add: typeof origAdd }).add = origAdd;
    }
  });

  test("reuse a failed row: failed → generating + re-enqueue", async () => {
    await resetOwner(owner.userId);
    await seedValidMedia(db, owner.userId, MIN);
    const failedId = await seedMontage(db, { userId: owner.userId, status: "failed" });
    const res = await post("/montages", owner.token);
    expect(res.statusCode).toBe(202);
    expect(res.json().montageId).toBe(failedId); // same row reused (one recap/day)
    expect(res.json().status).toBe("generating");
    const rows = await montageRowsFor(owner.userId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("generating");
  });

  test("unauthenticated ⇒ 401", async () => {
    const res = await app.inject({ method: "POST", url: "/montages", payload: "{}" });
    expect(res.statusCode).toBe(401);
  });
});

// ── 2. GET /montages/:id — owner-only + preview gating ───────────────────────
describe("GET /montages/:id", () => {
  test("owner gets the DTO; non-owner gets 404 (no existence leak)", async () => {
    await resetOwner(owner.userId);
    const id = await seedMontage(db, { userId: owner.userId, status: "generating" });

    const ok = await get(`/montages/${id}`, owner.token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(id);
    expect(ok.json().status).toBe("generating");

    const leak = await get(`/montages/${id}`, stranger.token);
    expect(leak.statusCode).toBe(404);
    expect(leak.json().error.code).toBe("MONTAGE_NOT_FOUND");

    const missing = await get(`/montages/00000000-0000-0000-0000-000000000000`, owner.token);
    expect(missing.statusCode).toBe(404);
  });

  test("previewUrl null while generating; signed once draft_ready (videoPath set)", async () => {
    await resetOwner(owner.userId);
    const gen = await seedMontage(db, { userId: owner.userId, status: "generating" });
    const genDto = (await get(`/montages/${gen}`, owner.token)).json();
    expect(genDto.previewUrl).toBeNull();

    await resetOwner(owner.userId);
    const draft = await seedMontage(db, {
      userId: owner.userId,
      status: "draft_ready",
      videoPath: `montages/${owner.userId}/${"x".repeat(8)}`,
      thumbnailPath: `thumbnails/${owner.userId}/poster`,
      durationMs: 30000,
    });
    const draftDto = (await get(`/montages/${draft}`, owner.token)).json();
    expect(typeof draftDto.previewUrl).toBe("string");
    expect(draftDto.previewUrl).toContain("9000"); // MinIO presigned host
    expect(typeof draftDto.thumbnailUrl).toBe("string");
    expect(draftDto.durationMs).toBe(30000);
    expect(draftDto.error).toBeNull();
  });

  test("failed row exposes the constant retryable error message", async () => {
    await resetOwner(owner.userId);
    const id = await seedMontage(db, { userId: owner.userId, status: "failed" });
    const dto = (await get(`/montages/${id}`, owner.token)).json();
    expect(dto.previewUrl).toBeNull();
    expect(typeof dto.error).toBe("string");
    expect(dto.error.length).toBeGreaterThan(0);
  });
});

// ── 3. GET /montages/options ─────────────────────────────────────────────────
describe("GET /montages/options", () => {
  test("returns all theme enum values + the bundled tracks", async () => {
    const res = await get("/montages/options", owner.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.themes).toEqual(["chill", "party", "clean", "travel", "random", "fast_cut", "soft"]);
    expect(Array.isArray(body.tracks)).toBe(true);
    expect(body.tracks.length).toBeGreaterThanOrEqual(1);
    for (const t of body.tracks) {
      expect(typeof t.id).toBe("string");
      expect(typeof t.title).toBe("string");
      expect(typeof t.durationMs).toBe("number");
      expect(typeof t.bpm).toBe("number");
    }
  });
});

// ── 4. POST /montages/:id/regenerate ─────────────────────────────────────────
describe("POST /montages/:id/regenerate", () => {
  test("generating ⇒ 409 MONTAGE_ALREADY_GENERATING", async () => {
    await resetOwner(owner.userId);
    const id = await seedMontage(db, { userId: owner.userId, status: "generating" });
    const res = await post(`/montages/${id}/regenerate`, owner.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("MONTAGE_ALREADY_GENERATING");
  });

  test("draft_ready ⇒ 202 generating + re-enqueue", async () => {
    await resetOwner(owner.userId);
    const id = await seedMontage(db, {
      userId: owner.userId,
      status: "draft_ready",
      videoPath: `montages/${owner.userId}/v`,
    });
    const res = await post(`/montages/${id}/regenerate`, owner.token);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("generating");
    expect((await db.db.select().from(montage).where(eq(montage.id, id)))[0]!.status).toBe("generating");
    const job = await queue.getJob(renderMontageJobId(id));
    expect(job?.id).toBe(renderMontageJobId(id));
  });

  test("remove-media: mediaIds below floor ⇒ 422 NOT_ENOUGH_MEDIA", async () => {
    await resetOwner(owner.userId);
    const mediaIds = await seedValidMedia(db, owner.userId, MIN);
    const id = await seedMontage(db, { userId: owner.userId, status: "draft_ready", sourceMediaIds: mediaIds });
    const res = await post(`/montages/${id}/regenerate`, owner.token, { mediaIds: mediaIds.slice(0, MIN - 1) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("NOT_ENOUGH_MEDIA");
  });

  test("non-owner ⇒ 404", async () => {
    await resetOwner(owner.userId);
    const id = await seedMontage(db, { userId: owner.userId, status: "draft_ready" });
    const res = await post(`/montages/${id}/regenerate`, stranger.token);
    expect(res.statusCode).toBe(404);
  });

  test("theme/musicId honored: regenerate updates the persisted row's theme + musicId", async () => {
    await resetOwner(owner.userId);
    const id = await seedMontage(db, {
      userId: owner.userId,
      status: "draft_ready",
      theme: "clean",
      musicId: "clean",
      videoPath: `montages/${owner.userId}/v`,
    });
    const res = await post(`/montages/${id}/regenerate`, owner.token, { theme: "party", musicId: "party" });
    expect(res.statusCode).toBe(202);
    const row = (await db.db.select().from(montage).where(eq(montage.id, id)))[0]!;
    expect(row.status).toBe("generating");
    expect(row.theme).toBe("party");
    expect(row.musicId).toBe("party");
  });

  test("omitted theme/musicId keep the row's current value", async () => {
    await resetOwner(owner.userId);
    const id = await seedMontage(db, {
      userId: owner.userId,
      status: "draft_ready",
      theme: "party",
      musicId: "party",
      videoPath: `montages/${owner.userId}/v`,
    });
    const res = await post(`/montages/${id}/regenerate`, owner.token); // no body
    expect(res.statusCode).toBe(202);
    const row = (await db.db.select().from(montage).where(eq(montage.id, id)))[0]!;
    expect(row.theme).toBe("party");
    expect(row.musicId).toBe("party");
  });

  test("published ⇒ 409 CONFLICT (regenerate would reset the 24h ephemerality clock)", async () => {
    await resetOwner(owner.userId);
    const id = await seedMontage(db, {
      userId: owner.userId,
      status: "published",
      videoPath: `montages/${owner.userId}/v`,
      publishedAt: new Date(),
      expiryAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const res = await post(`/montages/${id}/regenerate`, owner.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    // Row stays published — no silent unpublish.
    expect((await db.db.select().from(montage).where(eq(montage.id, id)))[0]!.status).toBe("published");
  });
});

// ── 5. POST /montages/:id/publish ────────────────────────────────────────────
describe("POST /montages/:id/publish", () => {
  test("publish to a member group ⇒ visibility row + published/expiry(+24h)", async () => {
    await resetOwner(owner.userId);
    const groupId = await createGroup(app, owner.token, `g-${N}-a`);
    const id = await seedMontage(db, {
      userId: owner.userId,
      status: "draft_ready",
      videoPath: `montages/${owner.userId}/v`,
    });
    const res = await post(`/montages/${id}/publish`, owner.token, { groupIds: [groupId] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("published");
    expect(body.groupIds).toEqual([groupId]);
    const published = new Date(body.publishedAt).getTime();
    const expiry = new Date(body.expiryAt).getTime();
    expect(expiry - published).toBe(24 * 60 * 60 * 1000);

    // Visibility row + row state persisted.
    const vis = await db.db
      .select()
      .from(montageGroupVisibility)
      .where(eq(montageGroupVisibility.montageId, id));
    expect(vis.length).toBe(1);
    expect(vis[0]!.groupId).toBe(groupId);
    const row = (await db.db.select().from(montage).where(eq(montage.id, id)))[0]!;
    expect(row.status).toBe("published");
    expect(row.expiryAt).not.toBeNull();
  });

  test("publish to a non-member group ⇒ 403 GROUP_NOT_MEMBER, nothing written", async () => {
    await resetOwner(owner.userId);
    // A group owned by the stranger — owner is not a member.
    const strangerGroup = await createGroup(app, stranger.token, `g-${N}-stranger`);
    const id = await seedMontage(db, { userId: owner.userId, status: "draft_ready" });
    const res = await post(`/montages/${id}/publish`, owner.token, { groupIds: [strangerGroup] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("GROUP_NOT_MEMBER");
    expect((await db.db.select().from(montage).where(eq(montage.id, id)))[0]!.status).toBe("draft_ready");
    const vis = await db.db
      .select()
      .from(montageGroupVisibility)
      .where(eq(montageGroupVisibility.montageId, id));
    expect(vis.length).toBe(0);
  });

  test("idempotent re-publish: same groupIds twice ⇒ one visibility row, unchanged publishedAt", async () => {
    await resetOwner(owner.userId);
    const groupId = await createGroup(app, owner.token, `g-${N}-idem`);
    const id = await seedMontage(db, { userId: owner.userId, status: "draft_ready" });
    const first = await post(`/montages/${id}/publish`, owner.token, { groupIds: [groupId] });
    expect(first.statusCode).toBe(200);
    const firstPublishedAt = first.json().publishedAt;

    const second = await post(`/montages/${id}/publish`, owner.token, { groupIds: [groupId] });
    expect(second.statusCode).toBe(200);
    expect(second.json().publishedAt).toBe(firstPublishedAt); // original timestamps kept
    const vis = await db.db
      .select()
      .from(montageGroupVisibility)
      .where(eq(montageGroupVisibility.montageId, id));
    expect(vis.length).toBe(1); // composite PK ⇒ no duplicate
  });

  test("one recap per user/group/day ⇒ a 2nd montage into the same group/day ⇒ 409 RECAP_ALREADY_TODAY", async () => {
    await resetOwner(owner.userId);
    const groupId = await createGroup(app, owner.token, `g-${N}-recap`);
    const bucket = todayBucket();
    const m1 = await seedMontage(db, { userId: owner.userId, status: "draft_ready", dayBucket: bucket });
    const m2 = await seedMontage(db, { userId: owner.userId, status: "draft_ready", dayBucket: bucket });
    const p1 = await post(`/montages/${m1}/publish`, owner.token, { groupIds: [groupId] });
    expect(p1.statusCode).toBe(200);
    const p2 = await post(`/montages/${m2}/publish`, owner.token, { groupIds: [groupId] });
    expect(p2.statusCode).toBe(409);
    expect(p2.json().error.code).toBe("RECAP_ALREADY_TODAY");
    // m2 stays unpublished.
    expect((await db.db.select().from(montage).where(eq(montage.id, m2)))[0]!.status).toBe("draft_ready");
  });

  test("precondition: publishing a generating montage ⇒ 409 CONFLICT", async () => {
    await resetOwner(owner.userId);
    const groupId = await createGroup(app, owner.token, `g-${N}-pre`);
    const id = await seedMontage(db, { userId: owner.userId, status: "generating" });
    const res = await post(`/montages/${id}/publish`, owner.token, { groupIds: [groupId] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  test("non-owner publish ⇒ 404", async () => {
    await resetOwner(owner.userId);
    const groupId = await createGroup(app, stranger.token, `g-${N}-no`);
    const id = await seedMontage(db, { userId: owner.userId, status: "draft_ready" });
    const res = await post(`/montages/${id}/publish`, stranger.token, { groupIds: [groupId] });
    expect(res.statusCode).toBe(404);
  });
});
