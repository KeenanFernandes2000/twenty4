/**
 * Slice 8 admin integration test — moderation + ops on the LIVE stack
 * (Postgres + Redis + MinIO). REAL sessions (email-OTP sign-up), a REAL admin
 * (promoted via is_admin), REAL published montages + reports + S3 objects.
 *
 * Proves (per Slice-8 acceptance):
 *   - requireAdmin: a NON-admin session hitting EVERY /admin/* route → 403
 *     forbidden (and the attempt is audited: an admin_access_denied tombstone).
 *   - suspend: admin suspends a user → the target's EXISTING session is revoked
 *     immediately (their next request → 403 suspended via requireSession) AND an
 *     account_suspended audit row is written. unsuspend restores access on re-login.
 *   - ban: same — existing session revoked, next request → 403 banned, audit row.
 *   - remove montage: admin removes a montage → S3 video+thumbnail GONE, the
 *     montage 404s, a deleteMontageContent-style tombstone (montage_removed_by_admin)
 *     is written, and its reactions/comments cascade-deleted.
 *   - resolve report: admin resolves an open report (remove_content) → the reported
 *     montage is removed + the report is closed (actioned) + audit row.
 *   - ops: GET /admin/ops returns per-queue job counts, per-bucket storage, metrics.
 *   - search: GET /admin/users finds a user by handle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  montages,
  montageGroupVisibility,
  reactions,
  comments,
  reports,
  auditLog,
  users,
  session as sessionTable,
} from '@twenty4/contracts/db';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import { buildApp } from '../src/app.js';
import { db, closeDb } from '../src/db/index.js';
import { closeRedis } from '../src/redis/index.js';
import { closeQueues } from '../src/queue/producers.js';
import { s3, buckets } from '../src/storage/s3.js';

const unique = Date.now();
const runId = unique.toString(36);
const TZ = 'UTC';

interface TestUser {
  token: string;
  userId: string;
  email: string;
}

const createdMontageIds: string[] = [];
const createdObjects: Array<{ bucket: string; key: string }> = [];
let ipCounter = 0;

/** Every admin route, with a method + a representative path (for the 403 sweep). */
function adminRoutes(sampleUserId: string, sampleMontageId: string, sampleReportId: string, sampleCommentId: string) {
  return [
    { method: 'GET' as const, url: '/admin/users?q=x' },
    { method: 'POST' as const, url: `/admin/users/${sampleUserId}/suspend` },
    { method: 'POST' as const, url: `/admin/users/${sampleUserId}/unsuspend` },
    { method: 'POST' as const, url: `/admin/users/${sampleUserId}/ban` },
    { method: 'GET' as const, url: '/admin/reports' },
    { method: 'POST' as const, url: `/admin/reports/${sampleReportId}/resolve`, payload: { action: 'dismiss' } },
    { method: 'POST' as const, url: `/admin/montages/${sampleMontageId}/remove`, payload: {} },
    { method: 'DELETE' as const, url: `/admin/comments/${sampleCommentId}` },
    { method: 'GET' as const, url: '/admin/ops' },
  ];
}

describe('admin: moderation + ops (live PG + redis + MinIO)', () => {
  let app: FastifyInstance;
  let dayBucket: string;

  async function signUp(tag: string): Promise<TestUser> {
    const email = `slice8a-${tag}-${unique}@twenty4.test`;
    const n = ipCounter++;
    const ip = `10.${(unique >> 8) & 0xff}.${unique & 0xff}.${(n % 254) + 1}`;
    const start = await app.inject({
      method: 'POST',
      url: '/auth/start',
      headers: { 'x-forwarded-for': ip },
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
    const patch = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: `s8a${tag}${runId}`.slice(0, 20), displayName: `S8A ${tag}` },
    });
    expect(patch.statusCode).toBe(200);
    return { token, userId: patch.json().id as string, email };
  }

  function auth(u: TestUser) {
    return { authorization: `Bearer ${u.token}` };
  }

  async function createGroup(u: TestUser, name: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/groups', headers: auth(u), payload: { name } });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function joinGroup(owner: TestUser, joiner: TestUser, groupId: string): Promise<void> {
    const inv = await app.inject({ method: 'POST', url: `/groups/${groupId}/invites`, headers: auth(owner), payload: {} });
    const code = inv.json().code as string;
    const join = await app.inject({ method: 'POST', url: `/invites/${code}/join`, headers: auth(joiner) });
    expect([200, 201]).toContain(join.statusCode);
  }

  async function seedPublishedMontage(owner: TestUser, groupIds: string[]): Promise<{ id: string; videoKey: string; thumbKey: string }> {
    const publishedAt = new Date();
    const expiryAt = new Date(publishedAt.getTime() + 24 * 3600 * 1000);
    const videoKey = `${owner.userId}/${dayBucket}/${randomUUID()}.mp4`;
    const thumbKey = `${owner.userId}/${dayBucket}/${randomUUID()}.jpg`;
    await s3.send(new PutObjectCommand({ Bucket: buckets.montages, Key: videoKey, Body: Buffer.from(`v-${randomUUID()}`), ContentType: 'video/mp4' }));
    await s3.send(new PutObjectCommand({ Bucket: buckets.thumbnails, Key: thumbKey, Body: Buffer.from(`t-${randomUUID()}`), ContentType: 'image/jpeg' }));
    createdObjects.push({ bucket: buckets.montages, key: videoKey });
    createdObjects.push({ bucket: buckets.thumbnails, key: thumbKey });
    const [row] = await db
      .insert(montages)
      .values({
        userId: owner.userId,
        dayBucket,
        status: 'published',
        theme: 'Party',
        musicId: 'house_120',
        videoPath: videoKey,
        thumbnailPath: thumbKey,
        durationMs: 30000,
        publishedAt,
        expiryAt,
      })
      .returning();
    createdMontageIds.push(row!.id);
    if (groupIds.length > 0) {
      await db.insert(montageGroupVisibility).values(groupIds.map((groupId) => ({ montageId: row!.id, groupId }))).onConflictDoNothing();
    }
    return { id: row!.id, videoKey, thumbKey };
  }

  let admin: TestUser; // promoted to is_admin
  let alice: TestUser; // a regular user / content owner
  let bob: TestUser; // a regular user / reporter / suspend+ban target
  let groupG: string;

  beforeAll(async () => {
    app = await buildApp();
    dayBucket = resolveDayBucket(new Date(), TZ);
    admin = await signUp('admin');
    alice = await signUp('alice');
    bob = await signUp('bob');
    // Promote `admin` directly (the production seed path is the ADMIN_EMAILS sign-in
    // hook; requireAdmin reads is_admin from the DB row on every request, so a direct
    // flag is the same gate the seed would set).
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.userId));

    groupG = await createGroup(alice, `gadmin-${runId}`);
    await joinGroup(alice, bob, groupG);
  });

  afterAll(async () => {
    if (createdMontageIds.length) {
      await db.delete(montages).where(inArray(montages.id, createdMontageIds)).catch(() => undefined);
    }
    for (const o of createdObjects) {
      await s3.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: o.key })).catch(() => undefined);
    }
    await app.close();
    await closeQueues();
    await closeDb();
    await closeRedis();
  });

  it('non-admin → 403 on EVERY /admin/* route (and the attempt is audited)', async () => {
    const seeded = await seedPublishedMontage(alice, [groupG]);
    const reportRow = await db
      .insert(reports)
      .values({ reporterId: bob.userId, targetType: 'montage', targetId: seeded.id, reason: 'spam', status: 'open' })
      .returning();
    const routes = adminRoutes(bob.userId, seeded.id, reportRow[0]!.id, randomUUID());

    for (const r of routes) {
      const payload = (r as { payload?: Record<string, unknown> }).payload;
      const res = await app.inject({
        method: r.method,
        url: r.url,
        headers: auth(alice),
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `non-admin ${r.method} ${r.url}`).toBe(403);
    }

    // A no-session request → 401 (not 403) on an admin route.
    const noAuth = await app.inject({ method: 'GET', url: '/admin/ops' });
    expect(noAuth.statusCode).toBe(401);

    // The rejected attempts were audited (admin_access_denied, actor = alice).
    const denials = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'admin_access_denied'), eq(auditLog.actorId, alice.userId)));
    expect(denials.length).toBeGreaterThanOrEqual(routes.length);
    // Content firewall: metadata holds only code-like path/method, no free text.
    const meta = denials[0]!.metadata as { method?: string; path?: string };
    expect(meta.method).toBeTruthy();
    expect(meta.path).toContain('admin');

    // The admin CAN hit the same routes (sanity: ops returns 200 for the admin).
    const okOps = await app.inject({ method: 'GET', url: '/admin/ops', headers: auth(admin) });
    expect(okOps.statusCode).toBe(200);
  });

  it('search users by handle', async () => {
    const res = await app.inject({ method: 'GET', url: `/admin/users?q=s8aalice${runId}`.slice(0, 60), headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: string; username: string }>;
    expect(items.some((u) => u.id === alice.userId)).toBe(true);
  });

  it('suspend revokes the existing session immediately + audits', async () => {
    // Bob has a working session right now.
    const before = await app.inject({ method: 'GET', url: '/users/me', headers: auth(bob) });
    expect(before.statusCode).toBe(200);

    const suspend = await app.inject({ method: 'POST', url: `/admin/users/${bob.userId}/suspend`, headers: auth(admin) });
    expect(suspend.statusCode).toBe(200);
    expect(suspend.json().accountStatus).toBe('suspended');

    // Bob's EXISTING token is now revoked: the session row is gone, so his next
    // request is unauthorized (no session) — and even if a session lingered, the
    // account_status=suspended gate would 403. Either way he's locked out NOW.
    const sessions = await db.select().from(sessionTable).where(eq(sessionTable.userId, bob.userId));
    expect(sessions.length).toBe(0);
    const after = await app.inject({ method: 'GET', url: '/users/me', headers: auth(bob) });
    expect([401, 403]).toContain(after.statusCode);

    // Audit row written (actor = admin).
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'account_suspended'), eq(auditLog.targetId, bob.userId)));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actorId).toBe(admin.userId);

    // The account_status really is suspended in the DB.
    const [bobRow] = await db.select({ s: users.accountStatus }).from(users).where(eq(users.id, bob.userId));
    expect(bobRow!.s).toBe('suspended');

    // Unsuspend → active; bob can sign in again and reach /users/me.
    const unsuspend = await app.inject({ method: 'POST', url: `/admin/users/${bob.userId}/unsuspend`, headers: auth(admin) });
    expect(unsuspend.statusCode).toBe(200);
    bob = await reSignIn(bob.email);
    const reachable = await app.inject({ method: 'GET', url: '/users/me', headers: auth(bob) });
    expect(reachable.statusCode).toBe(200);
  });

  it('ban revokes the existing session immediately + audits', async () => {
    const before = await app.inject({ method: 'GET', url: '/users/me', headers: auth(bob) });
    expect(before.statusCode).toBe(200);

    const ban = await app.inject({ method: 'POST', url: `/admin/users/${bob.userId}/ban`, headers: auth(admin) });
    expect(ban.statusCode).toBe(200);
    expect(ban.json().accountStatus).toBe('banned');

    const sessions = await db.select().from(sessionTable).where(eq(sessionTable.userId, bob.userId));
    expect(sessions.length).toBe(0);
    const after = await app.inject({ method: 'GET', url: '/users/me', headers: auth(bob) });
    expect([401, 403]).toContain(after.statusCode);

    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'account_banned'), eq(auditLog.targetId, bob.userId)));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.actorId).toBe(admin.userId);

    // A banned user CANNOT mint a new session (sign-in is blocked at the BA hook).
    const startBanned = await app.inject({
      method: 'POST',
      url: '/auth/start',
      headers: { 'x-forwarded-for': `10.55.${unique & 0xff}.${(ipCounter++ % 254) + 1}` },
      payload: { method: 'email', identifier: bob.email },
    });
    expect(startBanned.statusCode).toBe(200);
    const otp = await app.inject({ method: 'GET', url: `/auth/dev/last-otp?identifier=${encodeURIComponent(bob.email)}` });
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { challengeId: startBanned.json().challengeId, code: otp.json().code } });
    expect([401, 403]).toContain(verify.statusCode);
  });

  it('remove montage → content + S3 gone + 404 + audit + cascade', async () => {
    const owner = await signUp('owner1');
    await joinGroup(alice, owner, groupG);
    const seeded = await seedPublishedMontage(owner, [groupG]);

    // Add a reaction + comment so we can assert the cascade.
    await db.insert(reactions).values({ montageId: seeded.id, userId: alice.userId, type: 'fire' });
    await db.insert(comments).values({ montageId: seeded.id, userId: alice.userId, text: 'x', status: 'active' });

    // Sanity: the bytes are present before removal.
    const headBefore = await s3.send(new GetObjectCommand({ Bucket: buckets.montages, Key: seeded.videoKey })).then(() => true).catch(() => false);
    expect(headBefore).toBe(true);

    const remove = await app.inject({ method: 'POST', url: `/admin/montages/${seeded.id}/remove`, headers: auth(admin), payload: {} });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().removed).toBe(true);

    // Row gone (the owner GET → 404), S3 video+thumb gone, social cascaded.
    const ownerGet = await app.inject({ method: 'GET', url: `/montages/${seeded.id}`, headers: auth(owner) });
    expect(ownerGet.statusCode).toBe(404);
    const [montageRow] = await db.select().from(montages).where(eq(montages.id, seeded.id));
    expect(montageRow).toBeUndefined();
    const videoGone = await s3.send(new GetObjectCommand({ Bucket: buckets.montages, Key: seeded.videoKey })).then(() => false).catch(() => true);
    const thumbGone = await s3.send(new GetObjectCommand({ Bucket: buckets.thumbnails, Key: seeded.thumbKey })).then(() => false).catch(() => true);
    expect(videoGone).toBe(true);
    expect(thumbGone).toBe(true);
    const rxn = await db.select().from(reactions).where(eq(reactions.montageId, seeded.id));
    const cmt = await db.select().from(comments).where(eq(comments.montageId, seeded.id));
    expect(rxn.length).toBe(0);
    expect(cmt.length).toBe(0);

    // Audit tombstone (montage_removed_by_admin, actor = admin, content-free).
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'montage_removed_by_admin'), eq(auditLog.targetId, seeded.id)));
    expect(rows.length).toBe(1);
    expect(rows[0]!.actorId).toBe(admin.userId);

    // Removing again → 404 (idempotent — already gone).
    const removeAgain = await app.inject({ method: 'POST', url: `/admin/montages/${seeded.id}/remove`, headers: auth(admin), payload: {} });
    expect(removeAgain.statusCode).toBe(404);
  });

  it('resolve report (remove_content) closes the report + removes content + audits', async () => {
    const owner = await signUp('owner2');
    await joinGroup(alice, owner, groupG);
    const seeded = await seedPublishedMontage(owner, [groupG]);

    // A fresh active reporter (bob is banned by the prior test) — must be a group
    // member to SEE the montage and file a report through the real endpoint.
    const reporter = await signUp('reporter');
    await joinGroup(alice, reporter, groupG);
    const report = await app.inject({
      method: 'POST',
      url: '/reports',
      headers: auth(reporter),
      payload: { targetType: 'montage', targetId: seeded.id, reason: 'nudity' },
    });
    expect([200, 201]).toContain(report.statusCode);
    const reportId = report.json().id as string;

    // It shows in the OPEN report queue.
    const list = await app.inject({ method: 'GET', url: '/admin/reports', headers: auth(admin) });
    expect(list.statusCode).toBe(200);
    expect((list.json().items as Array<{ id: string }>).some((r) => r.id === reportId)).toBe(true);

    // Resolve with remove_content → montage removed + report actioned.
    const resolve = await app.inject({
      method: 'POST',
      url: `/admin/reports/${reportId}/resolve`,
      headers: auth(admin),
      payload: { action: 'remove_content' },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().status).toBe('actioned');
    expect(resolve.json().contentRemoved).toBe(true);

    const [rep] = await db.select().from(reports).where(eq(reports.id, reportId));
    expect(rep!.status).toBe('actioned');
    expect(rep!.resolvedByAdminId).toBe(admin.userId);
    expect(rep!.contentSnapshot).toBeNull(); // snapshot purged on resolve

    const [montageRow] = await db.select().from(montages).where(eq(montages.id, seeded.id));
    expect(montageRow).toBeUndefined();

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'report_actioned'), eq(auditLog.targetId, reportId)));
    expect(audits.length).toBe(1);

    // Re-resolving an already-resolved report → 409.
    const reResolve = await app.inject({
      method: 'POST',
      url: `/admin/reports/${reportId}/resolve`,
      headers: auth(admin),
      payload: { action: 'dismiss' },
    });
    expect(reResolve.statusCode).toBe(409);
  });

  it('ops returns queue counts + storage usage + metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/ops', headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      queues: Array<{ name: string; failed: number }>;
      storage: Array<{ bucket: string; objectCount: number; bytes: number }>;
      metrics: { publishedMontages: number; activeUsers: number; expiredMontages: number; openReports: number };
    };
    // The three known queues are present.
    const names = body.queues.map((q) => q.name);
    expect(names).toContain('montage');
    expect(names).toContain('media');
    expect(names).toContain('account');
    // The three buckets are reported.
    const bucketNames = body.storage.map((s) => s.bucket);
    expect(bucketNames).toContain(buckets.montages);
    expect(bucketNames).toContain(buckets.thumbnails);
    expect(bucketNames).toContain(buckets.raw);
    // Metrics are sane non-negative counts; we seeded montages + an active admin.
    expect(body.metrics.activeUsers).toBeGreaterThanOrEqual(1);
    expect(body.metrics.publishedMontages).toBeGreaterThanOrEqual(0);
  });

  /** Re-sign-in a user by email (after unsuspend) → a fresh token. */
  async function reSignIn(email: string): Promise<TestUser> {
    const ip = `10.77.${unique & 0xff}.${(ipCounter++ % 254) + 1}`;
    const start = await app.inject({ method: 'POST', url: '/auth/start', headers: { 'x-forwarded-for': ip }, payload: { method: 'email', identifier: email } });
    const otp = await app.inject({ method: 'GET', url: `/auth/dev/last-otp?identifier=${encodeURIComponent(email)}` });
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { challengeId: start.json().challengeId, code: otp.json().code } });
    const token = verify.json().accessToken as string;
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: { authorization: `Bearer ${token}` } });
    return { token, userId: me.json().id as string, email };
  }
});
