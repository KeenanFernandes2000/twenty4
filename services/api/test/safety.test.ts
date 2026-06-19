/**
 * Slice 8 safety integration test — reports + blocks on the LIVE stack
 * (Postgres + Redis + MinIO). REAL sessions (email-OTP sign-up), REAL group
 * membership (invite/join), REAL published montages (rows + visibility + bytes).
 *
 * Proves (per Slice-8 acceptance):
 *   - POST /blocks {userId}: B blocks A → A's montage disappears from B's feed AND
 *     B can no longer react/comment on it (404, no existence leak). Symmetric: the
 *     feed/social filter already hides both directions (Slice 6 authz).
 *   - GET /blocks: returns the blocked-user list with summaries; DELETE /blocks/:id
 *     unblocks → A's montage is visible to B again.
 *   - can't block yourself (422); block is idempotent.
 *   - POST /reports: a member can report a viewable montage/comment/user; a report
 *     against content the reporter CANNOT see → 404 (visibility-gated, no leak).
 *   - DEDUP: a repeat OPEN report by the same reporter against the same target is a
 *     no-op (returns the same report, 200 not 201; one row in the DB).
 *   - a montage report captures a content_snapshot marked for §13 7-day cleanup.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  montages,
  montageGroupVisibility,
  blocks,
  reports,
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

const emails: string[] = [];
const createdMontageIds: string[] = [];
const createdObjects: Array<{ bucket: string; key: string }> = [];
let ipCounter = 0;

describe('safety: reports + blocks (live PG + redis + MinIO)', () => {
  let app: FastifyInstance;
  let dayBucket: string;

  async function signUp(tag: string): Promise<TestUser> {
    const email = `slice8s-${tag}-${unique}@twenty4.test`;
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
    const patch = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: `s8s${tag}${runId}`.slice(0, 20), displayName: `S8 ${tag}` },
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
    expect([200, 201]).toContain(join.statusCode);
  }

  async function seedPublishedMontage(owner: TestUser, groupIds: string[]): Promise<string> {
    const publishedAt = new Date();
    const expiryAt = new Date(publishedAt.getTime() + 24 * 3600 * 1000);
    const videoKey = `${owner.userId}/${dayBucket}/${randomUUID()}.mp4`;
    const thumbKey = `${owner.userId}/${dayBucket}/${randomUUID()}.jpg`;

    await s3.send(
      new PutObjectCommand({ Bucket: buckets.montages, Key: videoKey, Body: Buffer.from(`v-${randomUUID()}`), ContentType: 'video/mp4' }),
    );
    await s3.send(
      new PutObjectCommand({ Bucket: buckets.thumbnails, Key: thumbKey, Body: Buffer.from(`t-${randomUUID()}`), ContentType: 'image/jpeg' }),
    );
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
      await db
        .insert(montageGroupVisibility)
        .values(groupIds.map((groupId) => ({ montageId: row!.id, groupId })))
        .onConflictDoNothing();
    }
    return row!.id;
  }

  let A: TestUser; // owner / publisher
  let B: TestUser; // member of G (reporter / blocker)
  let C: TestUser; // NOT a member of G (can't see A's montage)

  beforeAll(async () => {
    app = await buildApp();
    dayBucket = resolveDayBucket(new Date(), TZ);
    A = await signUp('a');
    B = await signUp('b');
    C = await signUp('c');
  });

  afterAll(async () => {
    // Clean up rows + S3 objects we created.
    if (createdMontageIds.length) {
      await db.delete(montages).where(inArray(montages.id, createdMontageIds)).catch(() => undefined);
    }
    for (const o of createdObjects) {
      await s3
        .send(new (await import('@aws-sdk/client-s3')).DeleteObjectCommand({ Bucket: o.bucket, Key: o.key }))
        .catch(() => undefined);
    }
    await app.close();
    await closeQueues();
    await closeDb();
    await closeRedis();
  });

  it('block hides content both ways + GET/DELETE blocks', async () => {
    const groupG = await createGroup(A, `g-${runId}`);
    await joinGroup(A, B, groupG);
    const montageId = await seedPublishedMontage(A, [groupG]);

    // B can see it + react before any block.
    const feedBefore = await app.inject({ method: 'GET', url: '/feed', headers: auth(B) });
    expect(feedBefore.statusCode).toBe(200);
    expect(feedBefore.json().items.some((m: { montageId: string }) => m.montageId === montageId)).toBe(true);

    const reactBefore = await app.inject({
      method: 'POST',
      url: `/montages/${montageId}/reactions`,
      headers: auth(B),
      payload: { type: 'fire' },
    });
    expect(reactBefore.statusCode).toBe(200);

    // B blocks A.
    const block = await app.inject({
      method: 'POST',
      url: '/blocks',
      headers: auth(B),
      payload: { userId: A.userId },
    });
    expect(block.statusCode).toBe(204);

    // Now A's montage is gone from B's feed AND B can't react/comment (404).
    const feedAfter = await app.inject({ method: 'GET', url: '/feed', headers: auth(B) });
    expect(feedAfter.json().items.some((m: { montageId: string }) => m.montageId === montageId)).toBe(false);

    const reactAfter = await app.inject({
      method: 'POST',
      url: `/montages/${montageId}/reactions`,
      headers: auth(B),
      payload: { type: 'like' },
    });
    expect(reactAfter.statusCode).toBe(404);

    const commentAfter = await app.inject({
      method: 'POST',
      url: `/montages/${montageId}/comments`,
      headers: auth(B),
      payload: { text: 'hi' },
    });
    expect(commentAfter.statusCode).toBe(404);

    // Symmetric: A (the blocked-by) also can't see B's content. B is already a
    // member of groupG; seed a published montage owned by B in that shared group.
    const bMontage = await seedPublishedMontage(B, [groupG]);
    const aFeed = await app.inject({ method: 'GET', url: '/feed', headers: auth(A) });
    expect(aFeed.json().items.some((m: { montageId: string }) => m.montageId === bMontage)).toBe(false);

    // GET /blocks lists A with a summary.
    const list = await app.inject({ method: 'GET', url: '/blocks', headers: auth(B) });
    expect(list.statusCode).toBe(200);
    const listed = list.json().items as Array<{ id: string; username: string }>;
    expect(listed.some((u) => u.id === A.userId)).toBe(true);

    // Idempotent re-block (204, still one row).
    const reBlock = await app.inject({
      method: 'POST',
      url: '/blocks',
      headers: auth(B),
      payload: { userId: A.userId },
    });
    expect(reBlock.statusCode).toBe(204);
    const blockRows = await db
      .select()
      .from(blocks)
      .where(and(eq(blocks.blockerId, B.userId), eq(blocks.blockedId, A.userId)));
    expect(blockRows.length).toBe(1);

    // DELETE /blocks/:userId → A visible again.
    const unblock = await app.inject({
      method: 'DELETE',
      url: `/blocks/${A.userId}`,
      headers: auth(B),
    });
    expect(unblock.statusCode).toBe(204);
    const feedUnblocked = await app.inject({ method: 'GET', url: '/feed', headers: auth(B) });
    expect(feedUnblocked.json().items.some((m: { montageId: string }) => m.montageId === montageId)).toBe(true);
  });

  it('cannot block self (422)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/blocks',
      headers: auth(B),
      payload: { userId: B.userId },
    });
    expect(res.statusCode).toBe(422);
  });

  it('report: visibility-gated + dedup + snapshot', async () => {
    const groupG = await createGroup(A, `gr-${runId}`);
    await joinGroup(A, B, groupG);
    const montageId = await seedPublishedMontage(A, [groupG]);

    // A non-member (C) reporting A's montage → 404 (can't see it, no leak).
    const cReport = await app.inject({
      method: 'POST',
      url: '/reports',
      headers: auth(C),
      payload: { targetType: 'montage', targetId: montageId, reason: 'spam' },
    });
    expect(cReport.statusCode).toBe(404);

    // B (a member) reports A's montage → 201, snapshot captured + purge-at set.
    const bReport = await app.inject({
      method: 'POST',
      url: '/reports',
      headers: auth(B),
      payload: { targetType: 'montage', targetId: montageId, reason: 'harassment', detail: 'mean' },
    });
    expect(bReport.statusCode).toBe(201);
    const reportId = bReport.json().id as string;
    expect(bReport.json().status).toBe('open');

    const [row] = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1);
    expect(row!.contentSnapshot).toBeTruthy();
    expect((row!.contentSnapshot as { montageId?: string }).montageId).toBe(montageId);
    expect(row!.snapshotPurgeAt).toBeTruthy();
    // Purge-at is ~7 days out.
    const days = (row!.snapshotPurgeAt!.getTime() - Date.now()) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(6.5);
    expect(days).toBeLessThan(7.5);

    // DEDUP: B re-reports the SAME montage → 200 (not 201), same report id, one row.
    const bReport2 = await app.inject({
      method: 'POST',
      url: '/reports',
      headers: auth(B),
      payload: { targetType: 'montage', targetId: montageId, reason: 'spam' },
    });
    expect(bReport2.statusCode).toBe(200);
    expect(bReport2.json().id).toBe(reportId);
    const dupRows = await db
      .select()
      .from(reports)
      .where(
        and(
          eq(reports.reporterId, B.userId),
          eq(reports.targetType, 'montage'),
          eq(reports.targetId, montageId),
        ),
      );
    expect(dupRows.length).toBe(1);

    // A user report (B reports A) → 201.
    const userReport = await app.inject({
      method: 'POST',
      url: '/reports',
      headers: auth(B),
      payload: { targetType: 'user', targetId: A.userId, reason: 'impersonation' },
    });
    expect(userReport.statusCode).toBe(201);

    // Can't report yourself.
    const selfReport = await app.inject({
      method: 'POST',
      url: '/reports',
      headers: auth(B),
      payload: { targetType: 'user', targetId: B.userId, reason: 'spam' },
    });
    expect(selfReport.statusCode).toBe(422);
  });
});
