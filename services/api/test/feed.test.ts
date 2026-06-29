// M8 feed + social — live-stack integration tests (§7). Real Postgres + Redis +
// MinIO via app.inject; rows seeded directly. Covers every §7 case: feed happy-path,
// reactions round-trip (replaceable/one-per-user), comments round-trip + delete-own
// + 403, symmetric block-hides-montage, symmetric block-hides-comments, authz no-leak
// (403 vs 404), keyset pagination, malformed-cursor → 422 (NOT 500), expired hidden,
// reaction-type validation, comment-too-long, and rate limits (429).
//
// The injected render-montage queue has a unique name no prod worker drains. Block
// rows are seeded directly (the write-API is M12). beforeEach wipes the test users'
// montages + blocks and flushes the social rate-limit counters so cases don't bleed.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { comment, montage, reaction } from "@twenty4/contracts/db";
import type { Queue } from "bullmq";
import type { DbClient } from "../src/db.ts";
import type { RedisClient } from "../src/redis.ts";
import type { RenderMontageJobData } from "../src/montage/queue.ts";
import {
  bearer,
  buildMontageApp,
  cleanupByPhones,
  createGroup,
  makeMontageDb,
  makeMontageEnv,
  makeMontageQueue,
  makeMontageRedis,
  todayBucket,
} from "./montageHelpers.ts";
import { phoneLogin } from "./authHelpers.ts";
import {
  addMemberDirect,
  flushSocialKeys,
  seedBlock,
  seedComment,
  seedPublishedMontage,
  setUserProfile,
} from "./feedHelpers.ts";

let app: FastifyInstance;
let db: DbClient;
let redis: RedisClient;
let queue: Queue<RenderMontageJobData>;
const env = makeMontageEnv(); // default caps: COMMENT_CREATE_CAP=10, REACTION_SET_CAP=30, COMMENT_MAX_LENGTH=500

const N = Date.now().toString().slice(-7);
const A_PHONE = `+1730${N}`;
const B_PHONE = `+1731${N}`;
const C_PHONE = `+1732${N}`;
const V_PHONE = `+1733${N}`;
const S_PHONE = `+1734${N}`;
const ALL_PHONES = [A_PHONE, B_PHONE, C_PHONE, V_PHONE, S_PHONE];

let A: { token: string; userId: string };
let B: { token: string; userId: string };
let C: { token: string; userId: string };
let V: { token: string; userId: string };
let S: { token: string; userId: string };
let groupId: string; // group X — the shared group everything publishes into
let groupY: string; // a SECOND group B also belongs to (no montages) — proves the filter constrains

const AVATAR = "https://cdn.local/ana.jpg";

beforeAll(async () => {
  db = makeMontageDb();
  redis = makeMontageRedis();
  queue = makeMontageQueue(env);
  await cleanupByPhones(db, ALL_PHONES);
  app = await buildMontageApp({ db, redis, env, queue });

  A = await phoneLogin(app, A_PHONE);
  B = await phoneLogin(app, B_PHONE);
  C = await phoneLogin(app, C_PHONE);
  V = await phoneLogin(app, V_PHONE);
  S = await phoneLogin(app, S_PHONE);

  // A owns the shared group X; B, C, V are direct members. S is NOT a member.
  groupId = await createGroup(app, A.token, `feed-${N}`);
  await addMemberDirect(db, groupId, B.userId);
  await addMemberDirect(db, groupId, C.userId);
  await addMemberDirect(db, groupId, V.userId);

  // Group Y — B is ALSO an active member, but nothing is ever published into it.
  // Lets the group-filter case prove ?group=Y EXCLUDES an X-only montage (a
  // regression that ignored the groupId arg would otherwise pass).
  groupY = await createGroup(app, A.token, `feedY-${N}`);
  await addMemberDirect(db, groupY, B.userId);

  // A has a display name + avatar so the feed author block is assertable.
  await setUserProfile(db, A.userId, "Ana", AVATAR);
});

afterAll(async () => {
  await cleanupByPhones(db, ALL_PHONES);
  await app.close();
  await queue.close();
  await db.sql.end({ timeout: 5 });
  await redis.quit();
});

// Clean slate per test: wipe the test users' montages (cascades reactions/comments/
// visibility) + any blocks among them, and flush the social rate-limit counters.
beforeEach(async () => {
  for (const uid of [A.userId, B.userId, C.userId, V.userId, S.userId]) {
    await db.sql`DELETE FROM montage WHERE user_id = ${uid}`;
    await db.sql`DELETE FROM block WHERE blocker_user_id = ${uid} OR blocked_user_id = ${uid}`;
  }
  await flushSocialKeys(redis);
});

// ── request helpers (parameterized by app for the custom-env cases) ──────────
function get(a: FastifyInstance, url: string, token: string) {
  return a.inject({ method: "GET", url, headers: bearer(token) });
}
function post(a: FastifyInstance, url: string, token: string, body?: unknown) {
  return a.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...bearer(token) },
    payload: JSON.stringify(body ?? {}),
  });
}
function del(a: FastifyInstance, url: string, token: string) {
  return a.inject({ method: "DELETE", url, headers: bearer(token) });
}

function cardFor(body: { items: Array<{ montageId: string }> }, id: string) {
  return body.items.find((c) => c.montageId === id);
}

// ── 1. Feed happy-path ───────────────────────────────────────────────────────
describe("GET /feed — happy path", () => {
  test("B (member) sees A's montage with full card shape", async () => {
    const id = await seedPublishedMontage(db, { userId: A.userId, groupId });

    const res = await get(app, "/feed", B.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const card = cardFor(body, id);
    expect(card).toBeDefined();
    expect(card.author.id).toBe(A.userId);
    expect(card.author.displayName).toBe("Ana");
    expect(card.author.avatarUrl).toBe(AVATAR);
    expect(card.dayBucket).toBe(todayBucket());
    expect(typeof card.expiryAt).toBe("string");
    expect(typeof card.videoUrl).toBe("string");
    expect(card.videoUrl).toContain("9000"); // MinIO presigned host
    expect(typeof card.thumbnailUrl).toBe("string");
    expect(card.durationMs).toBe(30000);
    expect(card.reactionCount).toBe(0);
    expect(card.commentCount).toBe(0);
    expect(card.viewerReaction).toBeNull();
    expect(card.commentPreview).toEqual([]);
    expect(card.canReport).toBe(true); // B is not the author
    expect(card.canDelete).toBe(false);
  });

  test("A sees their OWN montage card (no self-exclusion)", async () => {
    const id = await seedPublishedMontage(db, { userId: A.userId, groupId });
    const res = await get(app, "/feed", A.token);
    const card = cardFor(res.json(), id);
    expect(card).toBeDefined();
    expect(card.canDelete).toBe(true); // own montage
    expect(card.canReport).toBe(false);
  });

  test("unauthenticated ⇒ 401", async () => {
    const res = await app.inject({ method: "GET", url: "/feed" });
    expect(res.statusCode).toBe(401);
  });
});

// ── 2. Reactions round-trip ──────────────────────────────────────────────────
describe("reactions round-trip", () => {
  test("set → replace → count on A's view → clear (one replaceable row/user)", async () => {
    const id = await seedPublishedMontage(db, { userId: A.userId, groupId });

    const r1 = await post(app, `/montages/${id}/reactions`, B.token, { type: "fire" });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().count).toBe(1);
    expect(r1.json().viewerReaction).toBe("fire");

    const r2 = await post(app, `/montages/${id}/reactions`, B.token, { type: "heart" });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().count).toBe(1); // replaced, not added
    expect(r2.json().viewerReaction).toBe("heart");

    // Exactly one DB reaction row for (montage, B).
    const rows = await db.db.select().from(reaction).where(eq(reaction.montageId, id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.type).toBe("heart");

    // A's feed card reflects the count.
    const card = cardFor((await get(app, "/feed", A.token)).json(), id);
    expect(card.reactionCount).toBe(1);
    expect(card.viewerReaction).toBeNull(); // A didn't react

    const r3 = await del(app, `/montages/${id}/reactions`, B.token);
    expect(r3.statusCode).toBe(200);
    expect(r3.json().count).toBe(0);
    expect(r3.json().viewerReaction).toBeNull();
    expect((await db.db.select().from(reaction).where(eq(reaction.montageId, id))).length).toBe(0);
  });
});

// ── 3. Comments round-trip ───────────────────────────────────────────────────
describe("comments round-trip", () => {
  test("add → A's card count+preview → 403 on other's delete → delete-own → 0", async () => {
    const id = await seedPublishedMontage(db, { userId: A.userId, groupId });

    const add = await post(app, `/montages/${id}/comments`, B.token, { text: "nice recap" });
    expect(add.statusCode).toBe(201);
    expect(add.json().commentCount).toBe(1);
    expect(add.json().comment.text).toBe("nice recap");
    expect(add.json().comment.canDelete).toBe(true);
    const commentId = add.json().comment.id as string;

    // A's feed card shows count + preview.
    const card = cardFor((await get(app, "/feed", A.token)).json(), id);
    expect(card.commentCount).toBe(1);
    expect(card.commentPreview.length).toBe(1);
    expect(card.commentPreview[0].text).toBe("nice recap");

    // A cannot delete B's comment.
    const forbidden = await del(app, `/comments/${commentId}`, A.token);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("FORBIDDEN");

    // B deletes own → count 0, excluded from list.
    const rm = await del(app, `/comments/${commentId}`, B.token);
    expect(rm.statusCode).toBe(200);
    expect(rm.json().commentCount).toBe(0);

    const list = await get(app, `/montages/${id}/comments`, B.token);
    expect(list.json().items.length).toBe(0);

    // Re-deleting a soft-deleted comment ⇒ 404.
    const again = await del(app, `/comments/${commentId}`, B.token);
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("COMMENT_NOT_FOUND");
  });

  test("GET comments lists active block-clean comments with author", async () => {
    const id = await seedPublishedMontage(db, { userId: A.userId, groupId });
    await seedComment(db, { montageId: id, userId: B.userId, text: "first" });
    await seedComment(db, { montageId: id, userId: C.userId, text: "second" });
    const list = await get(app, `/montages/${id}/comments`, V.token);
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<{ text: string; author: { id: string } }>;
    expect(items.map((i) => i.text).sort()).toEqual(["first", "second"]);
  });
});

// ── 4. Block hides montage (both directions) ─────────────────────────────────
describe("block hides montage (symmetric)", () => {
  for (const dir of ["A->B", "B->A"] as const) {
    test(`block ${dir} ⇒ B's feed omits it + sub-resources 404`, async () => {
      const id = await seedPublishedMontage(db, { userId: A.userId, groupId });
      if (dir === "A->B") await seedBlock(db, A.userId, B.userId);
      else await seedBlock(db, B.userId, A.userId);

      const feed = await get(app, "/feed", B.token);
      expect(cardFor(feed.json(), id)).toBeUndefined();

      const reactRes = await post(app, `/montages/${id}/reactions`, B.token, { type: "fire" });
      expect(reactRes.statusCode).toBe(404);
      expect(reactRes.json().error.code).toBe("MONTAGE_NOT_FOUND");

      const commentsRes = await get(app, `/montages/${id}/comments`, B.token);
      expect(commentsRes.statusCode).toBe(404);
      expect(commentsRes.json().error.code).toBe("MONTAGE_NOT_FOUND");
    });
  }
});

// ── 5. Block hides comments (both directions) ────────────────────────────────
describe("block hides comments (symmetric)", () => {
  for (const dir of ["V->B", "B->V"] as const) {
    test(`block ${dir} ⇒ V's list + card preview/count exclude B, keep C`, async () => {
      const id = await seedPublishedMontage(db, { userId: A.userId, groupId });
      await seedComment(db, { montageId: id, userId: B.userId, text: "fromB" });
      await seedComment(db, { montageId: id, userId: C.userId, text: "fromC" });
      if (dir === "V->B") await seedBlock(db, V.userId, B.userId);
      else await seedBlock(db, B.userId, V.userId);

      const list = await get(app, `/montages/${id}/comments`, V.token);
      const texts = (list.json().items as Array<{ text: string }>).map((i) => i.text);
      expect(texts).toEqual(["fromC"]);

      const card = cardFor((await get(app, "/feed", V.token)).json(), id);
      expect(card.commentCount).toBe(1);
      expect(card.commentPreview.map((c: { text: string }) => c.text)).toEqual(["fromC"]);
    });
  }
});

// ── 6. Authz no-leak (403 vs 404) ────────────────────────────────────────────
describe("authz no-leak", () => {
  test("non-member GET /feed?group= ⇒ 403; reaction/comment on unseen montage ⇒ 404", async () => {
    const id = await seedPublishedMontage(db, { userId: A.userId, groupId });

    const scoped = await get(app, `/feed?group=${groupId}`, S.token);
    expect(scoped.statusCode).toBe(403);
    expect(scoped.json().error.code).toBe("NOT_A_MEMBER");

    const react = await post(app, `/montages/${id}/reactions`, S.token, { type: "fire" });
    expect(react.statusCode).toBe(404);
    expect(react.json().error.code).toBe("MONTAGE_NOT_FOUND");

    const comments = await get(app, `/montages/${id}/comments`, S.token);
    expect(comments.statusCode).toBe(404);

    const addC = await post(app, `/montages/${id}/comments`, S.token, { text: "hi" });
    expect(addC.statusCode).toBe(404);

    // Member-scoped filter works for a member.
    const ok = await get(app, `/feed?group=${groupId}`, B.token);
    expect(ok.statusCode).toBe(200);
    expect(cardFor(ok.json(), id)).toBeDefined();
  });

  test("group filter CONSTRAINS: ?group=Y (member, empty) excludes an X-only montage; ?group=X includes it", async () => {
    // B is an active member of BOTH X and Y; the montage is visible only in X. A
    // regression where montageVisibleTo authorizes membership but ignores its
    // groupId arg would still surface this card under ?group=Y — assert it does NOT.
    const id = await seedPublishedMontage(db, { userId: A.userId, groupId }); // into X only

    const inX = await get(app, `/feed?group=${groupId}`, B.token);
    expect(inX.statusCode).toBe(200);
    expect(cardFor(inX.json(), id)).toBeDefined();

    const inY = await get(app, `/feed?group=${groupY}`, B.token);
    expect(inY.statusCode).toBe(200); // B IS a member of Y (so not a 403) …
    expect(cardFor(inY.json(), id)).toBeUndefined(); // … but the X-only montage is absent

    const unscoped = await get(app, "/feed", B.token);
    expect(cardFor(unscoped.json(), id)).toBeDefined();
  });
});

// ── 7. Keyset pagination ─────────────────────────────────────────────────────
describe("keyset pagination", () => {
  test("25 montages ⇒ 10/page, walk cursors, no dupes/gaps, final nextCursor null", async () => {
    const base = Date.now();
    const seeded: string[] = [];
    for (let i = 0; i < 25; i++) {
      const publishedAt = new Date(base - i * 1000);
      const id = await seedPublishedMontage(db, {
        userId: A.userId,
        groupId,
        publishedAt,
        expiryAt: new Date(publishedAt.getTime() + 24 * 60 * 60 * 1000),
      });
      seeded.push(id);
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const url = cursor ? `/feed?cursor=${encodeURIComponent(cursor)}` : "/feed";
      const res = await get(app, url, B.token);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ montageId: string }>; nextCursor: string | null };
      pages++;
      if (pages === 1) expect(body.items.length).toBe(10);
      for (const it of body.items) collected.push(it.montageId);
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
      if (pages > 8) throw new Error("pagination did not terminate");
    }

    expect(pages).toBe(3); // 10 + 10 + 5
    expect(collected.length).toBe(25);
    expect(new Set(collected).size).toBe(25);
    expect([...collected].sort()).toEqual([...seeded].sort());
  });

  test("id tiebreaker: montages sharing one published_at across the page boundary walk exactly once", async () => {
    // 8 distinct-timestamp (newest) + 4 sharing ONE identical published_at (oldest)
    // = 12. With page size 10, the tie cluster straddles the page-1/page-2 boundary:
    // the cursor after page 1 carries that shared timestamp, so ONLY the (published_at,
    // id) row-value tiebreaker can return the remaining tied rows without dupes/gaps.
    // Dropping the `id` tiebreaker would drop the 2 tied rows on page 2 (a gap).
    const base = Date.now();
    const seeded: string[] = [];
    for (let i = 0; i < 8; i++) {
      const publishedAt = new Date(base - i * 1000);
      seeded.push(
        await seedPublishedMontage(db, {
          userId: A.userId,
          groupId,
          publishedAt,
          expiryAt: new Date(publishedAt.getTime() + 24 * 60 * 60 * 1000),
        }),
      );
    }
    const tiedAt = new Date(base - 8000); // identical published_at for the oldest 4
    for (let j = 0; j < 4; j++) {
      seeded.push(
        await seedPublishedMontage(db, {
          userId: A.userId,
          groupId,
          publishedAt: tiedAt,
          expiryAt: new Date(tiedAt.getTime() + 24 * 60 * 60 * 1000),
        }),
      );
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const url = cursor ? `/feed?cursor=${encodeURIComponent(cursor)}` : "/feed";
      const res = await get(app, url, B.token);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ montageId: string }>; nextCursor: string | null };
      pages++;
      for (const it of body.items) collected.push(it.montageId);
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
      if (pages > 6) throw new Error("pagination did not terminate");
    }

    expect(collected.length).toBe(12); // every montage exactly once …
    expect(new Set(collected).size).toBe(12); // … no dupes …
    expect([...collected].sort()).toEqual([...seeded].sort()); // … no gaps
  });
});

// ── 8. Malformed cursor ⇒ 422 (NOT 500) ──────────────────────────────────────
describe("malformed cursor ⇒ 422", () => {
  test("garbage cursor on /feed and /comments ⇒ 422 VALIDATION_FAILED", async () => {
    const id = await seedPublishedMontage(db, { userId: A.userId, groupId });
    for (const bad of ["garbage", "!!!notbase64!!!", "eyJib2d1cyI6dHJ1ZX0"]) {
      const feed = await get(app, `/feed?cursor=${encodeURIComponent(bad)}`, B.token);
      expect(feed.statusCode).toBe(422);
      expect(feed.json().error.code).toBe("VALIDATION_FAILED");

      const comments = await get(app, `/montages/${id}/comments?cursor=${encodeURIComponent(bad)}`, B.token);
      expect(comments.statusCode).toBe(422);
      expect(comments.json().error.code).toBe("VALIDATION_FAILED");
    }
  });
});

// ── 9. Expired hidden ────────────────────────────────────────────────────────
describe("expired montage hidden", () => {
  test("past expiry_at ⇒ absent from feed + 404 on sub-resources", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const id = await seedPublishedMontage(db, {
      userId: A.userId,
      groupId,
      publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      expiryAt: past,
    });

    const feed = await get(app, "/feed", B.token);
    expect(cardFor(feed.json(), id)).toBeUndefined();

    const react = await post(app, `/montages/${id}/reactions`, B.token, { type: "fire" });
    expect(react.statusCode).toBe(404);

    const comments = await get(app, `/montages/${id}/comments`, B.token);
    expect(comments.statusCode).toBe(404);
  });
});

// ── 10. Reaction-type validation ─────────────────────────────────────────────
describe("reaction-type validation", () => {
  test("invalid type ⇒ 422", async () => {
    const id = await seedPublishedMontage(db, { userId: A.userId, groupId });
    const res = await post(app, `/montages/${id}/reactions`, B.token, { type: "invalid" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });
});

// ── 11. Comment too long (env-configurable cap) ──────────────────────────────
describe("comment length cap", () => {
  test("text over COMMENT_MAX_LENGTH ⇒ 422", async () => {
    const lowEnv = makeMontageEnv({ COMMENT_MAX_LENGTH: "10" });
    const lowQueue = makeMontageQueue(lowEnv);
    const lowApp = await buildMontageApp({ db, redis, env: lowEnv, queue: lowQueue });
    try {
      const id = await seedPublishedMontage(db, { userId: A.userId, groupId });
      const ok = await post(lowApp, `/montages/${id}/comments`, B.token, { text: "0123456789" }); // 10 chars
      expect(ok.statusCode).toBe(201);
      const tooLong = await post(lowApp, `/montages/${id}/comments`, B.token, { text: "01234567890" }); // 11 chars
      expect(tooLong.statusCode).toBe(422);
      expect(tooLong.json().error.code).toBe("VALIDATION_FAILED");
    } finally {
      await lowApp.close();
      await lowQueue.close();
    }
  });
});

// ── 12. Rate limits (429) ────────────────────────────────────────────────────
describe("social rate limits", () => {
  test("comment + reaction caps ⇒ 3rd in window 429", async () => {
    const rlEnv = makeMontageEnv({ COMMENT_CREATE_CAP: "2", REACTION_SET_CAP: "2" });
    const rlQueue = makeMontageQueue(rlEnv);
    const rlApp = await buildMontageApp({ db, redis, env: rlEnv, queue: rlQueue });
    try {
      await flushSocialKeys(redis);
      const id = await seedPublishedMontage(db, { userId: A.userId, groupId });

      // Reactions: 2 ok, 3rd 429 (set/clear combined cap).
      expect((await post(rlApp, `/montages/${id}/reactions`, B.token, { type: "fire" })).statusCode).toBe(200);
      expect((await post(rlApp, `/montages/${id}/reactions`, B.token, { type: "heart" })).statusCode).toBe(200);
      const react3 = await post(rlApp, `/montages/${id}/reactions`, B.token, { type: "like" });
      expect(react3.statusCode).toBe(429);
      expect(react3.json().error.code).toBe("RATE_LIMITED");

      // Comments: 2 ok, 3rd 429.
      expect((await post(rlApp, `/montages/${id}/comments`, B.token, { text: "one" })).statusCode).toBe(201);
      expect((await post(rlApp, `/montages/${id}/comments`, B.token, { text: "two" })).statusCode).toBe(201);
      const c3 = await post(rlApp, `/montages/${id}/comments`, B.token, { text: "three" });
      expect(c3.statusCode).toBe(429);
      expect(c3.json().error.code).toBe("RATE_LIMITED");
    } finally {
      await flushSocialKeys(redis);
      await rlApp.close();
      await rlQueue.close();
    }
  });
});
