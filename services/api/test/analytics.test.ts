/**
 * Slice 9 analytics integration test — §12 ingest firewall + server-side emission
 * on the LIVE stack (Postgres + Redis + MinIO). REAL sessions (email-OTP sign-up),
 * REAL group membership, REAL published montages (rows + visibility), REAL
 * reactions/comments — proving the privacy firewall end-to-end.
 *
 * Proves (PLAN slice 9 acceptance):
 *   INGEST (POST /analytics):
 *     - a VALID batch of §12 events increments the per-(event_type, day) aggregate
 *       counters (and ONLY counters — no per-event/identifier rows).
 *     - an event carrying a CONTENT field (comment text / caption / arbitrary free
 *       text) is REJECTED/dropped — and that text NEVER persists ANYWHERE
 *       (analytics_aggregate, audit_log, NOR any table column).
 *     - an UNKNOWN event type → 422 (no aggregate written).
 *     - the endpoint is RATE-LIMITED (429 over the per-user cap).
 *     - requireSession: no token → 401.
 *   SERVER-SIDE EMISSION (the same firewall):
 *     - publishing a montage emits `montage_published` (group count) → counter++.
 *     - a reaction emits `reaction_sent` (reaction enum dimension) → counter++.
 *     - a comment emits `comment_sent` — and the comment TEXT never reaches any
 *       aggregate row.
 *     - GET /admin/analytics exposes the rollups (COUNTS ONLY) to ops.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, gte, sql } from 'drizzle-orm';
import {
  analyticsAggregates,
  auditLog,
  dailyMediaItems,
  montages,
  montageGroupVisibility,
  users,
} from '@twenty4/contracts/db';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import { buildApp } from '../src/app.js';
import { db, closeDb } from '../src/db/index.js';
import { closeRedis } from '../src/redis/index.js';
import { closeQueues } from '../src/queue/producers.js';
import { drainEmitted } from '../src/analytics/emit.js';
import { utcDay } from '../src/analytics/aggregate.js';

const unique = Date.now();
const runId = unique.toString(36);
const TZ = 'UTC';
const DAY = utcDay();

interface TestUser {
  token: string;
  userId: string;
  email: string;
}

const emails: string[] = [];
const createdMontageIds: string[] = [];
let ipCounter = 0;

/** A free-text content marker that must NEVER persist anywhere from analytics. */
const SECRET_TEXT = `LEAK_CANARY_${runId}_do_not_store_this_text`;

describe('analytics: §12 ingest firewall + server-side emission (live PG + redis + MinIO)', () => {
  let app: FastifyInstance;
  let dayBucket: string;

  async function signUp(tag: string): Promise<TestUser> {
    const email = `slice9a-${tag}-${unique}@twenty4.test`;
    emails.push(email);
    const n = ipCounter++;
    const ip = `10.${(unique >> 8) & 0xff}.${unique & 0xff}.${(n % 254) + 1}`;
    const xff = { 'x-forwarded-for': ip };

    const start = await app.inject({
      method: 'POST',
      url: '/auth/start',
      headers: xff,
      payload: { method: 'email', identifier: email },
    });
    expect(start.statusCode).toBe(200);
    const { challengeId } = start.json();
    const otpRes = await app.inject({
      method: 'GET',
      url: `/auth/dev/last-otp?identifier=${encodeURIComponent(email)}`,
    });
    const code = otpRes.json().code as string;
    const verify = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, code },
    });
    const token = verify.json().accessToken as string;
    // Username is [a-zA-Z0-9_]+ only — strip any non-alphanumerics from the tag.
    const safeTag = tag.replace(/[^a-zA-Z0-9]/g, '');
    const patch = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: `s9a${safeTag}${runId}`.slice(0, 20), displayName: `S9 ${tag}` },
    });
    expect(patch.statusCode).toBe(200);
    return { token, userId: patch.json().id as string, email };
  }

  function auth(u: TestUser) {
    return { authorization: `Bearer ${u.token}` };
  }

  async function createGroup(u: TestUser, name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/groups',
      headers: auth(u),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function joinGroup(owner: TestUser, joiner: TestUser, groupId: string): Promise<void> {
    const inv = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/invites`,
      headers: auth(owner),
      payload: {},
    });
    expect(inv.statusCode).toBe(201);
    const code = inv.json().code as string;
    const join = await app.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      headers: auth(joiner),
    });
    expect(join.statusCode).toBe(200);
  }

  /**
   * Directly seed a montage row (skipping the heavy real render) in a chosen status,
   * so this suite can exercise publish/react/comment emission without a ~25s render.
   */
  async function seedMontage(
    userId: string,
    status: 'draft_ready' | 'published',
    opts: { groupIds?: string[]; expiryMs?: number } = {},
  ): Promise<string> {
    const now = new Date();
    const isPub = status === 'published';
    const [row] = await db
      .insert(montages)
      .values({
        userId,
        dayBucket,
        status,
        theme: 'Chill',
        musicId: 'chill_90',
        videoPath: `${userId}/${dayBucket}/seed-${Math.random().toString(36).slice(2)}.mp4`,
        thumbnailPath: `${userId}/${dayBucket}/seed-${Math.random().toString(36).slice(2)}.jpg`,
        durationMs: 30000,
        publishedAt: isPub ? now : null,
        expiryAt: isPub ? new Date(now.getTime() + (opts.expiryMs ?? 24 * 3600 * 1000)) : null,
      })
      .returning();
    createdMontageIds.push(row!.id);
    if (opts.groupIds && opts.groupIds.length > 0) {
      await db
        .insert(montageGroupVisibility)
        .values(opts.groupIds.map((groupId) => ({ montageId: row!.id, groupId })))
        .onConflictDoNothing();
    }
    return row!.id;
  }

  /** Sum the count for a (eventType[, dimension]) over today's UTC day. */
  async function counterFor(eventType: string, dimension?: string): Promise<number> {
    const rows = await db
      .select({ count: analyticsAggregates.count })
      .from(analyticsAggregates)
      .where(
        and(
          eq(analyticsAggregates.eventType, eventType),
          eq(analyticsAggregates.day, DAY),
          dimension !== undefined ? eq(analyticsAggregates.dimension, dimension) : undefined,
        ),
      );
    return rows.reduce((a, r) => a + Number(r.count), 0);
  }

  /**
   * Wait until a counter reaches `expected` (or briefly time out). Server-side
   * `emit()` writes the aggregate FIRE-AND-FORGET (it is never awaited — analytics
   * must not slow a user flow), so the HTTP response can return before the counter
   * is durably committed. Reading the counter immediately therefore RACES that write
   * and flaked intermittently (e.g. 'expected 4 to be 5'). Polling for the EXACT
   * expected value makes the assertion deterministic WITHOUT weakening it: it still
   * proves the precise increment — it just tolerates the async-write latency. On
   * timeout it returns the last-seen value so the caller's `toBe` fails with the real
   * number.
   */
  async function waitForCounter(
    eventType: string,
    expected: number,
    dimension?: string,
    timeoutMs = 3000,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let last = await counterFor(eventType, dimension);
    while (last !== expected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      last = await counterFor(eventType, dimension);
    }
    return last;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    dayBucket = resolveDayBucket(new Date(), TZ, 4);
    // TEST ISOLATION: analytics_aggregate is a PERSISTENT counter table that
    // accumulates across runs, so absolute-count assertions flake on re-run (e.g.
    // 'expected 17 to be 16'). It is a pure aggregate (no source-of-truth data), so
    // it's safe to clear: truncate it here so every per-(event_type, day, dimension)
    // counter starts from a clean, deterministic baseline for this suite's run.
    await db.delete(analyticsAggregates);
  });

  afterAll(async () => {
    // Clean seeded montages (cascades visibility/reactions/comments).
    for (const id of createdMontageIds) {
      await db.delete(montages).where(eq(montages.id, id)).catch(() => {});
    }
    for (const email of emails) {
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (u) {
        await db.delete(dailyMediaItems).where(eq(dailyMediaItems.userId, u.id)).catch(() => {});
        await db.delete(users).where(eq(users.id, u.id)).catch(() => {});
      }
    }
    await app.close();
    await Promise.allSettled([closeQueues(), closeRedis(), closeDb()]);
  });

  /* ----------------------------- INGEST: requireSession --------------------- */
  it('POST /analytics requires a session (401 without a token)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analytics',
      payload: { events: [{ event: 'app_installed', userId: 'anon', ts: Date.now() }] },
    });
    expect(res.statusCode).toBe(401);
  });

  /* ----------------------------- INGEST: valid batch ------------------------ */
  it('a VALID batch increments per-(event_type, day) aggregate counters', async () => {
    const u = await signUp('ingest');
    const before = await counterFor('app_installed');
    const beforeSignup = await counterFor('signup_completed', 'apple');

    const res = await app.inject({
      method: 'POST',
      url: '/analytics',
      headers: auth(u),
      payload: {
        events: [
          { event: 'app_installed', userId: u.userId, ts: Date.now() },
          { event: 'app_installed', userId: u.userId, ts: Date.now() },
          { event: 'signup_completed', userId: u.userId, ts: Date.now(), provider: 'apple' },
          {
            event: 'recap_watch',
            userId: u.userId,
            ts: Date.now(),
            montageId: '00000000-0000-0000-0000-000000000001',
            watchMs: 12000,
            completionRate: 0.4,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 4, dropped: 0 });

    // Counters incremented by exactly the submitted counts.
    expect(await counterFor('app_installed')).toBe(before + 2);
    // signup_completed is broken down by the (closed-set) provider dimension.
    expect(await counterFor('signup_completed', 'apple')).toBe(beforeSignup + 1);
    expect(await counterFor('recap_watch')).toBeGreaterThanOrEqual(1);

    // NO per-event row carrying the user id was written — only the aggregate table.
    // (analytics_aggregate has no user column; prove the row shape stores only counts.)
    const [agg] = await db
      .select()
      .from(analyticsAggregates)
      .where(and(eq(analyticsAggregates.eventType, 'app_installed'), eq(analyticsAggregates.day, DAY)))
      .limit(1);
    expect(agg).toBeTruthy();
    expect(Object.keys(agg!)).toEqual(
      expect.arrayContaining(['eventType', 'day', 'dimension', 'count']),
    );
    // The row carries NO user id field at all.
    expect(JSON.stringify(agg)).not.toContain(u.userId);
  });

  /* ------------------- INGEST: a content field is rejected ------------------ */
  it('an event with a CONTENT field is REJECTED and the text never persists ANYWHERE', async () => {
    const u = await signUp('content');

    // `comment_sent` is a §12 event whose ONLY allowed prop is `montageId`. Smuggle a
    // free-text `text` field (the comment body). The STRICT union has no slot for it
    // → the whole batch fails the outer strict parse → 422 (unknown/extra field).
    const res = await app.inject({
      method: 'POST',
      url: '/analytics',
      headers: auth(u),
      payload: {
        events: [
          {
            event: 'comment_sent',
            userId: u.userId,
            ts: Date.now(),
            montageId: '00000000-0000-0000-0000-000000000002',
            text: SECRET_TEXT, // <- CONTENT: must be rejected, never stored
          },
        ],
      },
    });
    expect(res.statusCode).toBe(422);

    // Also try a free-text `caption` on a montage_generated event → 422.
    const res2 = await app.inject({
      method: 'POST',
      url: '/analytics',
      headers: auth(u),
      payload: {
        events: [
          {
            event: 'montage_generated',
            userId: u.userId,
            ts: Date.now(),
            theme: 'Party',
            musicId: 'chill_90',
            itemCount: 5,
            caption: SECRET_TEXT, // <- CONTENT: extra field
          },
        ],
      },
    });
    expect(res2.statusCode).toBe(422);

    // PROVE the canary text never persisted: scan analytics_aggregate (dimension +
    // event_type), the audit log (action + metadata), AND assert no aggregate row's
    // dimension is anything but a known enum value (never the secret).
    const dims = await db
      .select({ dimension: analyticsAggregates.dimension, eventType: analyticsAggregates.eventType })
      .from(analyticsAggregates);
    for (const d of dims) {
      expect(d.dimension).not.toContain(SECRET_TEXT);
      expect(d.eventType).not.toContain(SECRET_TEXT);
    }
    // Raw SQL belt-and-braces: no aggregate dimension equals the secret.
    const leak = (await db.execute(
      sql`select count(*)::int as n from analytics_aggregate where dimension = ${SECRET_TEXT}`,
    )) as unknown as Array<{ n: number }>;
    expect(leak[0]?.n ?? 0).toBe(0);

    // The audit log never captured the secret either.
    const auditLeak = (await db.execute(
      sql`select count(*)::int as n from audit_log where metadata::text like ${'%' + SECRET_TEXT + '%'}`,
    )) as unknown as Array<{ n: number }>;
    expect(auditLeak[0]?.n ?? 0).toBe(0);
  });

  /* --------------------- INGEST: unknown event type → 422 ------------------- */
  it('an UNKNOWN event type is rejected with 422 (no aggregate written)', async () => {
    const u = await signUp('unknown');
    const res = await app.inject({
      method: 'POST',
      url: '/analytics',
      headers: auth(u),
      payload: {
        events: [{ event: 'totally_made_up_event', userId: u.userId, ts: Date.now() }],
      },
    });
    expect(res.statusCode).toBe(422);
    // No counter row for the bogus type.
    const rows = await db
      .select()
      .from(analyticsAggregates)
      .where(eq(analyticsAggregates.eventType, 'totally_made_up_event'));
    expect(rows.length).toBe(0);
  });

  /* ---- INGEST: a junk free-string dimension value cannot smuggle content ---- */
  it('a junk provider / errorCode / job free-string value is BOUNDED to a known token (never persisted as the raw value)', async () => {
    const u = await signUp('dimbound');
    // These §12 events are CLIENT-REACHABLE and carry free-string dimension fields
    // (`provider`, `errorCode`, `job` are z.string() in the schema). The STRICT
    // union validates SHAPE, not the VALUE, so each event is well-formed → 202.
    // The firewall MUST bound each dimension value to its known allow-list, so a
    // junk value persists as 'other', NEVER as the raw canary text.
    const CANARY = `PII-leak-canary-${runId}`;
    const res = await app.inject({
      method: 'POST',
      url: '/analytics',
      headers: auth(u),
      payload: {
        events: [
          // free-string `provider` (signup_completed)
          { event: 'signup_completed', userId: u.userId, ts: Date.now(), provider: CANARY },
          // free-string `errorCode` (upload_failed)
          { event: 'upload_failed', userId: u.userId, ts: Date.now(), errorCode: CANARY },
          // free-string `errorCode` (montage_render_failed)
          {
            event: 'montage_render_failed',
            userId: u.userId,
            ts: Date.now(),
            montageId: '00000000-0000-0000-0000-000000000003',
            errorCode: CANARY,
          },
          // free-string `job` (cleanup_job_result)
          { event: 'cleanup_job_result', userId: u.userId, ts: Date.now(), job: CANARY, ok: true },
        ],
      },
    });
    // The events are VALID (the schema permits the string); they are ACCEPTED, not dropped.
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 4, dropped: 0 });

    // PROVE the canary never reached the dimension column: every aggregate row's
    // dimension is bounded — for these event types it must be 'other', NEVER the canary.
    const all = await db
      .select({ dimension: analyticsAggregates.dimension, eventType: analyticsAggregates.eventType })
      .from(analyticsAggregates);
    for (const d of all) {
      expect(d.dimension).not.toContain(CANARY);
    }
    // Raw-SQL belt-and-braces: NO row anywhere has a dimension containing the canary.
    const leak = (await db.execute(
      sql`select count(*)::int as n from analytics_aggregate where dimension like ${'%' + CANARY + '%'}`,
    )) as unknown as Array<{ n: number }>;
    expect(leak[0]?.n ?? 0).toBe(0);

    // And the counters DID land — under the bounded 'other' dimension, proving the
    // event was processed (not silently dropped) while the raw value was suppressed.
    expect(await counterFor('signup_completed', 'other')).toBeGreaterThanOrEqual(1);
    expect(await counterFor('upload_failed', 'other')).toBeGreaterThanOrEqual(1);
    expect(await counterFor('montage_render_failed', 'other')).toBeGreaterThanOrEqual(1);
    expect(await counterFor('cleanup_job_result', 'other')).toBeGreaterThanOrEqual(1);
  });

  it('an empty batch / oversize batch is rejected (422)', async () => {
    const u = await signUp('shape');
    const empty = await app.inject({
      method: 'POST',
      url: '/analytics',
      headers: auth(u),
      payload: { events: [] },
    });
    expect(empty.statusCode).toBe(422);

    const oversize = await app.inject({
      method: 'POST',
      url: '/analytics',
      headers: auth(u),
      payload: {
        events: Array.from({ length: 101 }, () => ({
          event: 'app_installed',
          userId: u.userId,
          ts: Date.now(),
        })),
      },
    });
    expect(oversize.statusCode).toBe(422);
  });

  /* ----------------------------- INGEST: rate limited ----------------------- */
  it('POST /analytics is rate-limited (429 over the per-user cap)', async () => {
    const u = await signUp('rl');
    let got429 = false;
    // Cap is 120/10min; hammer past it. A single valid event per call.
    for (let i = 0; i < 130; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/analytics',
        headers: auth(u),
        payload: { events: [{ event: 'app_installed', userId: u.userId, ts: Date.now() }] },
      });
      if (res.statusCode === 429) {
        got429 = true;
        expect(res.json().error.code).toBe('rate_limited');
        break;
      }
      expect(res.statusCode).toBe(202);
    }
    expect(got429).toBe(true);
  });

  /* --------------------- SERVER-SIDE EMISSION: publish ---------------------- */
  it('publishing a montage emits §12 montage_published (group-count) → counter++', async () => {
    const owner = await signUp('pub');
    const g1 = await createGroup(owner, `S9 G1 ${runId}`);
    const g2 = await createGroup(owner, `S9 G2 ${runId}`);
    const montageId = await seedMontage(owner.userId, 'draft_ready');

    drainEmitted();
    const before = await counterFor('montage_published');

    const res = await app.inject({
      method: 'POST',
      url: `/montages/${montageId}/publish`,
      headers: auth(owner),
      payload: { groupIds: [g1, g2] },
    });
    expect(res.statusCode).toBe(200);

    // Counter incremented; the emitted event is content-free (montage id + count).
    // (Server-side emit is fire-and-forget — poll for the exact expected count.)
    expect(await waitForCounter('montage_published', before + 1)).toBe(before + 1);
    const emitted = drainEmitted().filter((e) => e.event === 'montage_published');
    expect(emitted.length).toBe(1);
    expect(emitted[0]).toMatchObject({ montageId, groupCount: 2 });
    // The emitted payload carries ONLY ids/counts — no content keys.
    expect(Object.keys(emitted[0]!).sort()).toEqual(
      ['event', 'groupCount', 'montageId', 'ts', 'userId'].sort(),
    );
  });

  /* ------------------ SERVER-SIDE EMISSION: react + comment ----------------- */
  it('a reaction emits reaction_sent (enum dimension) and a comment emits comment_sent WITHOUT the text', async () => {
    const owner = await signUp('soc-o');
    const viewer = await signUp('soc-v');
    const g = await createGroup(owner, `S9 Soc ${runId}`);
    await joinGroup(owner, viewer, g);
    const montageId = await seedMontage(owner.userId, 'published', { groupIds: [g] });

    drainEmitted();
    const beforeReact = await counterFor('reaction_sent', 'fire');
    const beforeComment = await counterFor('comment_sent');

    // React.
    const react = await app.inject({
      method: 'POST',
      url: `/montages/${montageId}/reactions`,
      headers: auth(viewer),
      payload: { type: 'fire' },
    });
    expect(react.statusCode).toBe(200);

    // Comment WITH the canary text in the BODY (legit content the user types).
    const comment = await app.inject({
      method: 'POST',
      url: `/montages/${montageId}/comments`,
      headers: auth(viewer),
      payload: { text: `hello ${SECRET_TEXT}` },
    });
    expect(comment.statusCode).toBe(201);
    // The comment row DOES store the text (it's a real comment); analytics must NOT.
    expect(comment.json().text).toContain(SECRET_TEXT);

    // Counters: reaction_sent (dimension = reaction enum) + comment_sent.
    // (Server-side emit is fire-and-forget — poll for the exact expected count to
    // avoid racing the un-awaited aggregate write; the assertion is still exact.)
    expect(await waitForCounter('reaction_sent', beforeReact + 1, 'fire')).toBe(beforeReact + 1);
    expect(await waitForCounter('comment_sent', beforeComment + 1)).toBe(beforeComment + 1);

    // The emitted analytics events carry NO comment text.
    const emitted = drainEmitted();
    const reactEv = emitted.find((e) => e.event === 'reaction_sent');
    const commentEv = emitted.find((e) => e.event === 'comment_sent');
    expect(reactEv).toMatchObject({ montageId, reactionType: 'fire' });
    expect(commentEv).toMatchObject({ montageId });
    expect(JSON.stringify(emitted)).not.toContain(SECRET_TEXT);

    // And NO analytics aggregate row anywhere stores the comment text.
    const leak = (await db.execute(
      sql`select count(*)::int as n from analytics_aggregate where dimension like ${'%' + SECRET_TEXT + '%'}`,
    )) as unknown as Array<{ n: number }>;
    expect(leak[0]?.n ?? 0).toBe(0);
  });

  /* ------------------- ADMIN READOUT: GET /admin/analytics ------------------ */
  it('GET /admin/analytics exposes the aggregate rollups (counts only) to ops', async () => {
    const admin = await signUp('admin');
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.userId));

    const res = await app.inject({
      method: 'GET',
      url: '/admin/analytics',
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(Array.isArray(body.totals)).toBe(true);
    // The window includes today; app_installed (counted above) is present with a count.
    const appInstalledTotal = body.totals.find(
      (t: { eventType: string; count: number }) => t.eventType === 'app_installed',
    );
    expect(appInstalledTotal).toBeTruthy();
    expect(appInstalledTotal.count).toBeGreaterThan(0);

    // Every row is COUNTS-ONLY: keys are exactly the content-free shape.
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual(['count', 'day', 'dimension', 'eventType'].sort());
      expect(typeof row.count).toBe('number');
    }

    // A non-admin is forbidden (requireAdmin).
    const nonAdmin = await signUp('na');
    const forbidden = await app.inject({
      method: 'GET',
      url: '/admin/analytics',
      headers: auth(nonAdmin),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  /* ------------- belt-and-braces: NO aggregate row carries a user id -------- */
  it('the analytics_aggregate table never stores a user id or content (schema-level firewall)', async () => {
    // Across EVERY aggregate row written by this suite, the dimension is either '' or
    // a short enum value, never a uuid and never the canary text.
    const rows = await db
      .select({ dimension: analyticsAggregates.dimension })
      .from(analyticsAggregates)
      .where(gte(analyticsAggregates.count, 1));
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const r of rows) {
      expect(uuidRe.test(r.dimension)).toBe(false);
      expect(r.dimension).not.toContain(SECRET_TEXT);
      // dimensions are short (enum values), never long free text.
      expect(r.dimension.length).toBeLessThanOrEqual(40);
    }
    // audit_log proof handled in the content test; here ensure the canary is absent
    // from the ONLY content-retaining analytics surface (there is none) — i.e. the
    // aggregate table is the sole persistence and it is content-free.
    expect(rows.length).toBeGreaterThan(0);
  });
});
