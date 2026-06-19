/**
 * §6 DELETION SUITE — THE EXIT GATE for Slice 7 (the core 24h-deletion promise).
 *
 * Runs against the LIVE stack (Postgres + MinIO) on REAL objects. Each test seeds
 * real rows + real S3 bytes, runs the EXACT job function the BullMQ worker invokes,
 * and asserts: rows gone, S3 404, audit tombstone present + content-free, §12
 * analytics carry only ids/counts/enums. Idempotency is asserted by running twice.
 *
 * Coverage (mirrors the prompt's exit-gate checklist):
 *   1. Raw purged after grace (cleanupRaw): all raw rows gone + S3 404 (used+unused),
 *      draft renders gone. Idempotent.
 *   2. Montage + social gone at 24h (expireMontage): row gone, reactions+comments+
 *      visibility gone (cascade), video+thumb S3 404, tombstone with NO content.
 *      Idempotent.
 *   3. Belt-and-suspenders (sweepExpiries): published montage past expiry with NO
 *      delayed job → swept.
 *   4. Leaked URL 404: presigned GET captured before expiry → 404 after expireMontage.
 *   5. Day-close sweep: unpublished media in a CLOSED day_bucket → purged (rows+S3).
 *   6. Account purge: user with media+montages+reactions+comments+memberships+blocks+
 *      sessions → ALL gone (each table asserted), tombstone written. Idempotent.
 *   7. Replace cascade (supersedeCleanup): prior montage + its reactions/comments +
 *      S3 hard-deleted; replacement lives.
 *   8. Analytics carry NO content: emitted §12 events contain only ids/counts/enums.
 *   9. Tombstone metadata firewall: a content-laden metadata value is stripped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  users,
  groups,
  groupMembers,
  montages,
  montageGroupVisibility,
  reactions,
  comments,
  blocks,
  session as sessionTable,
  verification,
  idempotencyKeys,
  dailyMediaItems,
  auditLog,
} from '@twenty4/contracts/db';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';

import { db, closeDb } from '../src/db.js';
import { s3, buckets, closeStorage } from '../src/storage.js';
import { expireMontage } from '../src/jobs/expireMontage.js';
import { sweepExpiries } from '../src/jobs/sweepExpiries.js';
import { rawPurgeSweep } from '../src/jobs/rawPurgeSweep.js';
import { cleanupRaw } from '../src/jobs/cleanupRaw.js';
import { dayCloseSweep } from '../src/jobs/dayCloseSweep.js';
import { purgeAccount } from '../src/jobs/purgeAccount.js';
import { supersedeCleanup } from '../src/jobs/supersedeCleanup.js';
import { drainAnalytics, emitAnalytics } from '../src/lib/analytics.js';
import { sanitizeMetadata, writeAuditTombstone } from '../src/lib/audit.js';

const TZ = 'UTC';
const runTag = randomUUID().slice(0, 8);

/* ------------------------------- seed helpers ------------------------------ */

let userSeq = 0;
/** Insert a minimal real user row; returns its id. */
async function makeUser(opts: { email?: string; phone?: string } = {}): Promise<string> {
  const id = randomUUID();
  const handle = `del${runTag}${userSeq++}`;
  await db.execute(sql`
    insert into users (id, username, display_name, account_status, email, phone)
    values (${id}, ${handle}, ${'Del Test'}, 'active', ${opts.email ?? null}, ${opts.phone ?? null})
  `);
  return id;
}

/** Insert a real Better Auth session for a user; returns its token. */
async function makeSession(userId: string): Promise<string> {
  const token = randomUUID();
  await db.insert(sessionTable).values({
    token,
    userId,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return token;
}

/** Create a group owned by `userId` + add owner as active member; returns group id. */
async function makeGroup(userId: string): Promise<string> {
  const [g] = await db
    .insert(groups)
    .values({ name: `g-${runTag}-${randomUUID().slice(0, 6)}`, ownerId: userId })
    .returning();
  await db
    .insert(groupMembers)
    .values({ groupId: g!.id, userId, role: 'owner', status: 'active' });
  return g!.id;
}

/** PUT real bytes to a bucket under a namespaced key; returns the key. */
async function putObject(
  bucket: string,
  userId: string,
  dayBucket: string,
  ext: string,
  contentType: string,
): Promise<string> {
  const key = `${userId}/${dayBucket}/${randomUUID()}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(`bytes-${key}`),
      ContentType: contentType,
    }),
  );
  return key;
}

/** True if an object exists (HeadObject succeeds), false on 404. */
async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Insert a raw daily_media_item with a real S3 object; returns {id, key}. */
async function makeRawMedia(
  userId: string,
  dayBucket: string,
  opts: { processingStatus?: 'valid' | 'used'; expiryAt?: Date | null } = {},
): Promise<{ id: string; key: string }> {
  const key = await putObject(buckets.raw, userId, dayBucket, 'jpg', 'image/jpeg');
  const [row] = await db
    .insert(dailyMediaItems)
    .values({
      userId,
      dayBucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storagePath: key,
      capturedInApp: true,
      deviceTimezone: TZ,
      validationStatus: 'valid',
      processingStatus: opts.processingStatus ?? 'valid',
      expiryAt: opts.expiryAt ?? null,
    })
    .returning();
  return { id: row!.id, key };
}

interface SeededMontage {
  id: string;
  videoKey: string;
  thumbKey: string;
}

/** Insert a montage with real video+thumb S3 objects. */
async function makeMontage(
  userId: string,
  dayBucket: string,
  opts: {
    status?: 'published' | 'draft_ready' | 'failed';
    publishedAt?: Date;
    expiryAt?: Date | null;
  } = {},
): Promise<SeededMontage> {
  const videoKey = await putObject(buckets.montages, userId, dayBucket, 'mp4', 'video/mp4');
  const thumbKey = await putObject(buckets.thumbnails, userId, dayBucket, 'jpg', 'image/jpeg');
  const [row] = await db
    .insert(montages)
    .values({
      userId,
      dayBucket,
      status: opts.status ?? 'published',
      videoPath: videoKey,
      thumbnailPath: thumbKey,
      durationMs: 30000,
      theme: 'Chill',
      musicId: 'chill_90',
      publishedAt: opts.publishedAt ?? (opts.status === 'published' ? new Date() : null),
      expiryAt:
        opts.expiryAt === undefined
          ? opts.status === 'published'
            ? new Date(Date.now() + 24 * 3600 * 1000)
            : null
          : opts.expiryAt,
    })
    .returning();
  return { id: row!.id, videoKey, thumbKey };
}

/** Link a montage to a group (visibility). */
async function makeVisible(montageId: string, groupId: string): Promise<void> {
  await db
    .insert(montageGroupVisibility)
    .values({ montageId, groupId })
    .onConflictDoNothing();
}

/** Add a reaction (by `byUserId`) to a montage. */
async function addReaction(montageId: string, byUserId: string): Promise<void> {
  await db
    .insert(reactions)
    .values({ montageId, userId: byUserId, type: 'fire' })
    .onConflictDoNothing();
}

/** Add a comment (by `byUserId`) to a montage. */
async function addComment(montageId: string, byUserId: string, text = 'nice'): Promise<void> {
  await db.insert(comments).values({ montageId, userId: byUserId, text });
}

/* --------------------------- count / existence ----------------------------- */

async function countRows(table: string, where: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(
    sql`select count(*)::int as n from ${sql.raw(table)} where ${where}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function montageExists(id: string): Promise<boolean> {
  const [r] = await db.select({ id: montages.id }).from(montages).where(eq(montages.id, id)).limit(1);
  return !!r;
}

/** Most recent audit_log tombstone for a target id + action. */
async function latestTombstone(action: string, targetId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(sql`${auditLog.action} = ${action} and ${auditLog.targetId} = ${targetId}`)
    .orderBy(sql`${auditLog.createdAt} desc`)
    .limit(1);
  return row;
}

/** Track seeded user ids so we can clean up even on failure. */
const seededUsers: string[] = [];
async function newUser(opts: { email?: string; phone?: string } = {}): Promise<string> {
  const id = await makeUser(opts);
  seededUsers.push(id);
  return id;
}

describe('§6 deletion suite — the exit gate (live PG + MinIO, real objects)', () => {
  beforeAll(() => {
    drainAnalytics(); // start clean
  });

  afterEach(() => {
    drainAnalytics(); // isolate analytics assertions per test
  });

  afterAll(async () => {
    // Best-effort cleanup: deleting the user cascades the rest.
    for (const id of seededUsers) {
      await db.delete(users).where(eq(users.id, id)).catch(() => undefined);
    }
    await closeDb();
    closeStorage();
  });

  /* ----------------------- 1. raw purged after grace ----------------------- */
  it('1. cleanupRaw — ALL raw rows gone + S3 404 (used+unused) + draft renders gone, idempotent', async () => {
    const u = await newUser();
    const day = resolveDayBucket(new Date(), TZ);

    const used = await makeRawMedia(u, day, { processingStatus: 'used' });
    const unused = await makeRawMedia(u, day, { processingStatus: 'valid' });
    // A draft render for the same day (must be purged); plus a PUBLISHED montage
    // for the day (must SURVIVE cleanupRaw — it owns its own 24h expiry).
    const draft = await makeMontage(u, day, { status: 'draft_ready' });
    const published = await makeMontage(u, day, { status: 'published' });

    expect(await objectExists(buckets.raw, used.key)).toBe(true);
    expect(await objectExists(buckets.raw, unused.key)).toBe(true);

    const res = await cleanupRaw(u, day, published.id);
    expect(res.rawRowsDeleted).toBe(2);
    expect(res.draftMontagesDeleted).toBe(1);

    // Raw rows + objects GONE (both used and unused).
    expect(await countRows('daily_media_item', sql`user_id = ${u}`)).toBe(0);
    expect(await objectExists(buckets.raw, used.key)).toBe(false);
    expect(await objectExists(buckets.raw, unused.key)).toBe(false);
    // Draft render gone (row + S3); published montage SURVIVES.
    expect(await montageExists(draft.id)).toBe(false);
    expect(await objectExists(buckets.montages, draft.videoKey)).toBe(false);
    expect(await montageExists(published.id)).toBe(true);
    expect(await objectExists(buckets.montages, published.videoKey)).toBe(true);

    // Tombstone written (no content).
    const tomb = await latestTombstone('raw_media_purged', u);
    expect(tomb).toBeTruthy();
    expect(JSON.stringify(tomb!.metadata)).not.toContain('bytes-');

    // IDEMPOTENT: a second run is a safe no-op.
    const again = await cleanupRaw(u, day, published.id);
    expect(again.rawRowsDeleted).toBe(0);
    expect(again.draftMontagesDeleted).toBe(0);
  });

  /* -------------------- 2. montage + social gone at 24h -------------------- */
  it('2. expireMontage — montage+reactions+comments+visibility gone (cascade), video+thumb 404, content-free tombstone, idempotent', async () => {
    const owner = await newUser();
    const friendA = await newUser();
    const friendB = await newUser();
    const day = resolveDayBucket(new Date(), TZ);
    const group = await makeGroup(owner);

    const m = await makeMontage(owner, day, { status: 'published' });
    await makeVisible(m.id, group);
    await addReaction(m.id, friendA);
    await addReaction(m.id, friendB);
    await addComment(m.id, friendA, 'secret comment text');

    // sanity: social + S3 present before.
    expect(await countRows('reaction', sql`montage_id = ${m.id}`)).toBe(2);
    expect(await countRows('comment', sql`montage_id = ${m.id}`)).toBe(1);
    expect(await countRows('montage_group_visibility', sql`montage_id = ${m.id}`)).toBe(1);
    expect(await objectExists(buckets.montages, m.videoKey)).toBe(true);
    expect(await objectExists(buckets.thumbnails, m.thumbKey)).toBe(true);

    const res = await expireMontage(m.id);
    expect(res.status).toBe('expired');
    expect(res.reactionCount).toBe(2);
    expect(res.commentCount).toBe(1);

    // Row + ALL social gone (FK cascade).
    expect(await montageExists(m.id)).toBe(false);
    expect(await countRows('reaction', sql`montage_id = ${m.id}`)).toBe(0);
    expect(await countRows('comment', sql`montage_id = ${m.id}`)).toBe(0);
    expect(await countRows('montage_group_visibility', sql`montage_id = ${m.id}`)).toBe(0);
    // S3 video + thumb 404.
    expect(await objectExists(buckets.montages, m.videoKey)).toBe(false);
    expect(await objectExists(buckets.thumbnails, m.thumbKey)).toBe(false);

    // Tombstone: counts only, NO content (the comment text must not appear anywhere).
    const tomb = await latestTombstone('montage_expired', m.id);
    expect(tomb).toBeTruthy();
    expect(tomb!.targetType).toBe('montage');
    const metaStr = JSON.stringify(tomb!.metadata);
    expect(metaStr).not.toContain('secret comment text');
    expect(tomb!.metadata).toMatchObject({ reactions: 2, comments: 1, groups: 1 });

    // IDEMPOTENT: rerun → no-op (row already gone).
    const again = await expireMontage(m.id);
    expect(again.status).toBe('skipped');
  });

  /* ----------------------- 3. belt-and-suspenders -------------------------- */
  it('3. sweepExpiries — published montage past expiry with NO delayed job → swept', async () => {
    const owner = await newUser();
    const day = resolveDayBucket(new Date(), TZ);
    // expiry_at in the PAST → due. No delayed job exists (we never scheduled one).
    const m = await makeMontage(owner, day, {
      status: 'published',
      publishedAt: new Date(Date.now() - 25 * 3600 * 1000),
      expiryAt: new Date(Date.now() - 3600 * 1000),
    });
    await addReaction(m.id, await newUser());

    expect(await montageExists(m.id)).toBe(true);

    const res = await sweepExpiries();
    expect(res.expired).toBeGreaterThanOrEqual(1);

    expect(await montageExists(m.id)).toBe(false);
    expect(await objectExists(buckets.montages, m.videoKey)).toBe(false);
    const tomb = await latestTombstone('montage_expired', m.id);
    expect(tomb).toBeTruthy();
  });

  /* --------------------------- 4. leaked URL 404 --------------------------- */
  it('4. leaked URL — a presigned GET captured BEFORE expiry 404s AFTER expireMontage', async () => {
    const owner = await newUser();
    const day = resolveDayBucket(new Date(), TZ);
    const m = await makeMontage(owner, day, { status: 'published' });

    // Capture a presigned GET while the content is live (long TTL so the URL itself
    // is still valid — proving it's the DELETED OBJECT, not URL expiry, that 404s).
    const leakedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: buckets.montages, Key: m.videoKey }),
      { expiresIn: 3600 },
    );

    // Before expiry the URL fetches the bytes.
    const before = await fetch(leakedUrl);
    expect(before.status).toBe(200);

    await expireMontage(m.id);

    // After expiry the SAME url 404s (object gone, §6/§11).
    const after = await fetch(leakedUrl);
    expect(after.status).toBe(404);
  });

  /* ---------------------------- 5. day-close sweep ------------------------- */
  it('5. dayCloseSweep — unpublished media in a CLOSED day_bucket → purged (rows+S3)', async () => {
    const u = await newUser();
    // A CLOSED day (5 days ago) with raw media but NO published montage.
    const closedDay = resolveDayBucket(new Date(Date.now() - 5 * 24 * 3600 * 1000), TZ);
    const r1 = await makeRawMedia(u, closedDay);
    const r2 = await makeRawMedia(u, closedDay);
    const draft = await makeMontage(u, closedDay, { status: 'failed' });

    // A separate user with TODAY's media that must NOT be swept (day still open).
    const today = resolveDayBucket(new Date(), TZ);
    const openUser = await newUser();
    const openRaw = await makeRawMedia(openUser, today);

    const res = await dayCloseSweep();
    expect(res.rawRowsDeleted).toBeGreaterThanOrEqual(2);

    // Closed-day raw + draft GONE (rows + S3).
    expect(await countRows('daily_media_item', sql`user_id = ${u}`)).toBe(0);
    expect(await objectExists(buckets.raw, r1.key)).toBe(false);
    expect(await objectExists(buckets.raw, r2.key)).toBe(false);
    expect(await montageExists(draft.id)).toBe(false);
    // Today's open-day raw SURVIVES.
    expect(await countRows('daily_media_item', sql`user_id = ${openUser}`)).toBe(1);
    expect(await objectExists(buckets.raw, openRaw.key)).toBe(true);
  });

  /* ----------------------------- 6. account purge -------------------------- */
  it('6. purgeAccount — media+montages+reactions+comments+memberships+blocks+sessions ALL gone, tombstone, idempotent', async () => {
    const me = await newUser();
    const other = await newUser();
    const day = resolveDayBucket(new Date(), TZ);

    // me owns: media, a group, a published montage (with social from `other`).
    const myRaw = await makeRawMedia(me, day);
    const myGroup = await makeGroup(me);
    const myMontage = await makeMontage(me, day, { status: 'published' });
    await makeVisible(myMontage.id, myGroup);
    await addReaction(myMontage.id, other);
    await addComment(myMontage.id, other, 'comment on my montage');

    // me also authored social ELSEWHERE (on `other`'s montage) — must be purged too.
    const othersMontage = await makeMontage(other, day, { status: 'published' });
    await addReaction(othersMontage.id, me);
    await addComment(othersMontage.id, me, 'my comment elsewhere');

    // me has a session + a block (both directions) + a group membership in other's group.
    await makeSession(me);
    const otherGroup = await makeGroup(other);
    await db.insert(groupMembers).values({ groupId: otherGroup, userId: me, status: 'active' });
    await db.insert(blocks).values({ blockerId: me, blockedId: other });
    await db.insert(blocks).values({ blockerId: other, blockedId: me });

    const requestedAt = new Date().toISOString();
    const res = await purgeAccount(me, requestedAt);
    expect(res.purged).toBe(true);
    expect(res.montagesDeleted).toBeGreaterThanOrEqual(1);

    // EVERYTHING owned by `me` is gone — assert each table.
    expect(await countRows('users', sql`id = ${me}`)).toBe(0);
    expect(await countRows('daily_media_item', sql`user_id = ${me}`)).toBe(0);
    expect(await countRows('montage', sql`user_id = ${me}`)).toBe(0);
    expect(await countRows('groups', sql`owner_id = ${me}`)).toBe(0);
    expect(await countRows('group_members', sql`user_id = ${me}`)).toBe(0);
    expect(await countRows('block', sql`blocker_id = ${me} or blocked_id = ${me}`)).toBe(0);
    expect(await countRows('session', sql`user_id = ${me}`)).toBe(0);
    // Reactions/comments me authored ELSEWHERE are gone (cascade from users).
    expect(await countRows('reaction', sql`user_id = ${me}`)).toBe(0);
    expect(await countRows('comment', sql`user_id = ${me}`)).toBe(0);
    // me's montage S3 gone.
    expect(await objectExists(buckets.montages, myMontage.videoKey)).toBe(false);
    expect(await objectExists(buckets.raw, myRaw.key)).toBe(false);
    // `other`'s montage SURVIVES (not me's content) but my social on it is gone.
    expect(await montageExists(othersMontage.id)).toBe(true);
    expect(await countRows('reaction', sql`montage_id = ${othersMontage.id}`)).toBe(0);

    // Account tombstone written (no content).
    const tomb = await latestTombstone('account_deleted', me);
    expect(tomb).toBeTruthy();
    expect(JSON.stringify(tomb!.metadata)).not.toContain('comment');

    // IDEMPOTENT: rerun after the row is gone → safe no-op.
    const again = await purgeAccount(me, requestedAt);
    expect(again.purged).toBe(false);
  });

  /* ---------------------------- 7. replace cascade ------------------------- */
  it('7. supersedeCleanup — prior montage + its reactions/comments + S3 hard-deleted; replacement lives', async () => {
    const owner = await newUser();
    const fan = await newUser();
    const day = resolveDayBucket(new Date(), TZ);
    const group = await makeGroup(owner);

    // M1 published with reactions/comments; M2 published as the replacement.
    const m1 = await makeMontage(owner, day, { status: 'published' });
    await makeVisible(m1.id, group);
    await addReaction(m1.id, fan);
    await addComment(m1.id, fan, 'old montage comment');
    const m2 = await makeMontage(owner, day, { status: 'published' });
    await makeVisible(m2.id, group);
    // Mark m1 superseded (as the API replace flow does) before the cleanup job runs.
    await db
      .update(montages)
      .set({ status: 'deleted_by_user', supersededBy: m2.id })
      .where(eq(montages.id, m1.id));

    const res = await supersedeCleanup(m1.id);
    expect(res.status).toBe('deleted');

    // M1 + its social + S3 gone.
    expect(await montageExists(m1.id)).toBe(false);
    expect(await countRows('reaction', sql`montage_id = ${m1.id}`)).toBe(0);
    expect(await countRows('comment', sql`montage_id = ${m1.id}`)).toBe(0);
    expect(await objectExists(buckets.montages, m1.videoKey)).toBe(false);
    expect(await objectExists(buckets.thumbnails, m1.thumbKey)).toBe(false);
    // M2 LIVES with its 24h clock + S3 intact.
    expect(await montageExists(m2.id)).toBe(true);
    expect(await objectExists(buckets.montages, m2.videoKey)).toBe(true);
    const [m2row] = await db.select().from(montages).where(eq(montages.id, m2.id)).limit(1);
    expect(m2row!.status).toBe('published');
    expect(m2row!.expiryAt).toBeTruthy();

    // Tombstone for the replace (no content).
    const tomb = await latestTombstone('montage_replaced', m1.id);
    expect(tomb).toBeTruthy();
    expect(JSON.stringify(tomb!.metadata)).not.toContain('old montage comment');

    // IDEMPOTENT.
    const again = await supersedeCleanup(m1.id);
    expect(again.status).toBe('skipped');
  });

  /* -------------------- 8. analytics carry NO content ---------------------- */
  it('8. analytics — emitted §12 events contain ONLY ids/counts/enums (no content)', async () => {
    const owner = await newUser();
    const fan = await newUser();
    const day = resolveDayBucket(new Date(), TZ);
    const m = await makeMontage(owner, day, { status: 'published' });
    await addComment(m.id, fan, 'this text must never reach analytics');

    drainAnalytics(); // clear pre-test noise
    await expireMontage(m.id);
    await cleanupRaw(owner, day);

    const events = drainAnalytics();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      // Every value must be a primitive id/number/enum — never the comment text.
      const json = JSON.stringify(e);
      expect(json).not.toContain('this text must never reach analytics');
      // Allowed value types only.
      for (const [, v] of Object.entries(e)) {
        expect(['string', 'number', 'boolean']).toContain(typeof v);
      }
    }
    // The strict schema would have THROWN on a content field; reaching here = clean.
    // Sanity: a bad event with extra content fails the schema firewall.
    expect(() =>
      emitAnalytics({
        // @ts-expect-error — proving the strict schema rejects an unknown content field
        event: 'expired_media_deleted_count',
        userId: owner,
        ts: Date.now(),
        count: 1,
        commentText: 'leak',
      }),
    ).toThrow();
  });

  /* ------------------- 9. tombstone metadata firewall ---------------------- */
  it('9. audit tombstone — sanitizer strips content-bearing metadata fields', async () => {
    const u = await newUser();
    const long =
      'a long freeform sentence with spaces that is clearly user content not an id';
    const safe = sanitizeMetadata({
      reactions: 5,
      ok: true,
      userId: u, // uuid → kept
      reason: 'expired', // short code → kept
      caption: long, // content → DROPPED
      nested: { text: long, count: 3 }, // text dropped, count kept
    });
    expect(safe.reactions).toBe(5);
    expect(safe.ok).toBe(true);
    expect(safe.userId).toBe(u);
    expect(safe.reason).toBe('expired');
    expect(safe.caption).toBeUndefined();
    expect((safe.nested as Record<string, unknown>).text).toBeUndefined();
    expect((safe.nested as Record<string, unknown>).count).toBe(3);

    // And via the real writer: the dropped field never lands in the row.
    const targetId = randomUUID();
    await writeAuditTombstone({
      actorId: null,
      action: 'content_removed',
      targetType: 'montage',
      targetId,
      metadata: { caption: long, count: 1 },
    });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, targetId))
      .limit(1);
    expect(JSON.stringify(row!.metadata)).not.toContain('freeform sentence');
    expect((row!.metadata as Record<string, unknown>).count).toBe(1);
  });

  /* ================================================================== *
   *  LOST-JOB BACKSTOP REGRESSIONS — prove the sweep reclaims ALL       *
   *  content INDEPENDENT of any delayed / supersede / cleanup job.      *
   * ================================================================== */

  /* ---- Fix 1: replace, then sweep WITHOUT supersede-cleanup --------- */
  it('B1. sweepExpiries reclaims a SUPERSEDED montage with content — NO supersede-cleanup job ran', async () => {
    const owner = await newUser();
    const fan = await newUser();
    const day = resolveDayBucket(new Date(), TZ);
    const group = await makeGroup(owner);

    // A formerly-LIVE published montage with content + social.
    const prior = await makeMontage(owner, day, { status: 'published' });
    await makeVisible(prior.id, group);
    await addReaction(prior.id, fan);
    await addComment(prior.id, fan, 'prior montage secret comment');

    // Simulate EXACTLY what the API replace flow does to the prior row: flip it to
    // deleted_by_user + point superseded_by at a replacement — but DO NOT run the
    // supersede-cleanup job (the lost-job scenario). The content/row/social survive.
    const replacement = await makeMontage(owner, day, { status: 'published' });
    await db
      .update(montages)
      .set({ status: 'deleted_by_user', supersededBy: replacement.id })
      .where(eq(montages.id, prior.id));

    // Pre-state: the prior row + its S3 + its social are STILL HERE (job was lost).
    expect(await montageExists(prior.id)).toBe(true);
    expect(await objectExists(buckets.montages, prior.videoKey)).toBe(true);
    expect(await countRows('reaction', sql`montage_id = ${prior.id}`)).toBe(1);

    // The BACKSTOP: the repeatable sweep — with no supersede-cleanup ever scheduled —
    // reclaims the prior montage's bytes + row + social anyway.
    const res = await sweepExpiries();
    expect(res.expired).toBeGreaterThanOrEqual(1);

    // Prior montage: S3 bytes gone, row gone, social gone (FK cascade).
    expect(await montageExists(prior.id)).toBe(false);
    expect(await objectExists(buckets.montages, prior.videoKey)).toBe(false);
    expect(await objectExists(buckets.thumbnails, prior.thumbKey)).toBe(false);
    expect(await countRows('reaction', sql`montage_id = ${prior.id}`)).toBe(0);
    expect(await countRows('comment', sql`montage_id = ${prior.id}`)).toBe(0);
    expect(await countRows('montage_group_visibility', sql`montage_id = ${prior.id}`)).toBe(0);
    // The live replacement is UNTOUCHED.
    expect(await montageExists(replacement.id)).toBe(true);
    expect(await objectExists(buckets.montages, replacement.videoKey)).toBe(true);
    // A content-free tombstone records the reclamation.
    const tomb = await latestTombstone('montage_replaced', prior.id);
    expect(tomb).toBeTruthy();
    expect(JSON.stringify(tomb!.metadata)).not.toContain('secret comment');
  });

  /* ---- Fix 2b: raw-purge-sweep reclaims raw with NO cleanup-raw job -- */
  it('B2. rawPurgeSweep reclaims a published day\'s raw (rows+S3) — NO cleanup-raw job ran; published montage survives', async () => {
    const owner = await newUser();
    const day = resolveDayBucket(new Date(), TZ);

    // A published montage for the day + its raw, where the API stamped the raw with a
    // past `expiry_at` (= published_at + grace) but the +60min cleanup-raw job was lost.
    const published = await makeMontage(owner, day, { status: 'published' });
    const raw1 = await makeRawMedia(owner, day, {
      processingStatus: 'used',
      expiryAt: new Date(Date.now() - 60 * 1000), // already due
    });
    const raw2 = await makeRawMedia(owner, day, {
      processingStatus: 'valid',
      expiryAt: new Date(Date.now() - 60 * 1000),
    });

    expect(await objectExists(buckets.raw, raw1.key)).toBe(true);

    // BACKSTOP: the raw sweep hard-deletes due raw rows+S3 with no cleanup-raw job.
    const res = await rawPurgeSweep();
    expect(res.rawRowsDeleted).toBeGreaterThanOrEqual(2);

    // Raw rows + S3 gone.
    expect(await countRows('daily_media_item', sql`user_id = ${owner}`)).toBe(0);
    expect(await objectExists(buckets.raw, raw1.key)).toBe(false);
    expect(await objectExists(buckets.raw, raw2.key)).toBe(false);
    // The PUBLISHED montage SURVIVES independently (it owns its own 24h expiry).
    expect(await montageExists(published.id)).toBe(true);
    expect(await objectExists(buckets.montages, published.videoKey)).toBe(true);

    // IDEMPOTENT.
    const again = await rawPurgeSweep();
    expect(again.rawRowsDeleted).toBe(0);
  });

  /* ---- Fix 2c: dayCloseSweep purges a PUBLISHED closed day's raw ----- */
  it('B3. dayCloseSweep purges a PUBLISHED, CLOSED day\'s raw (no skip-published) — published montage survives', async () => {
    const owner = await newUser();
    // A CLOSED day (5 days ago) that HAS a published montage AND lingering raw.
    const closedDay = resolveDayBucket(new Date(Date.now() - 5 * 24 * 3600 * 1000), TZ);
    const published = await makeMontage(owner, closedDay, {
      status: 'published',
      publishedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
      expiryAt: new Date(Date.now() - 4 * 24 * 3600 * 1000),
    });
    const raw1 = await makeRawMedia(owner, closedDay); // expiry_at null — never stamped
    const raw2 = await makeRawMedia(owner, closedDay);

    const res = await dayCloseSweep();
    expect(res.rawRowsDeleted).toBeGreaterThanOrEqual(2);

    // Even though the day HAS a published montage, its raw is purged (day closed).
    expect(await countRows('daily_media_item', sql`user_id = ${owner}`)).toBe(0);
    expect(await objectExists(buckets.raw, raw1.key)).toBe(false);
    expect(await objectExists(buckets.raw, raw2.key)).toBe(false);
    // The published montage row + S3 SURVIVE (it lives on independently).
    expect(await montageExists(published.id)).toBe(true);
    expect(await objectExists(buckets.montages, published.videoKey)).toBe(true);
  });

  /* ---- Fix 3: orphan draft on a closed day whose raw is already gone - */
  it('B4. dayCloseSweep deletes an ORPHAN draft on a CLOSED day with NO raw rows left', async () => {
    const owner = await newUser();
    const closedDay = resolveDayBucket(new Date(Date.now() - 6 * 24 * 3600 * 1000), TZ);
    // A draft_ready montage on a closed day, with NO raw rows (its raw was already
    // swept) — the old design would only delete it as a side effect of purgeRawForDay
    // finding raw, so it survived forever. The new montage-direct scan reclaims it.
    const orphan = await makeMontage(owner, closedDay, { status: 'draft_ready' });
    expect(await countRows('daily_media_item', sql`user_id = ${owner}`)).toBe(0);
    expect(await montageExists(orphan.id)).toBe(true);

    const res = await dayCloseSweep();
    expect(res.draftMontagesDeleted).toBeGreaterThanOrEqual(1);

    // Orphan draft row + S3 gone, with no raw rows involved.
    expect(await montageExists(orphan.id)).toBe(false);
    expect(await objectExists(buckets.montages, orphan.videoKey)).toBe(false);
  });

  /* ---- Fix 4: CHECK constraint forbids published + NULL expiry ------- */
  it('B5. DB CHECK rejects inserting a PUBLISHED montage with NULL expiry_at', async () => {
    const owner = await newUser();
    const day = resolveDayBucket(new Date(), TZ);
    // The constraint (status<>published OR expiry_at IS NOT NULL) makes the latent
    // forever-leak impossible at the source — the insert is rejected by the DB.
    await expect(
      db.execute(sql`
        insert into montage (user_id, day_bucket, status, video_path, expiry_at)
        values (${owner}, ${day}, 'published', 'some/key.mp4', null)
      `),
    ).rejects.toThrow();
    // And a published row WITH an expiry_at is accepted (sanity).
    await expect(
      db.execute(sql`
        insert into montage (user_id, day_bucket, status, video_path, expiry_at)
        values (${owner}, ${day}, 'published', 'some/key.mp4', now() + interval '24 hours')
      `),
    ).resolves.toBeTruthy();
  });

  /* ---- Fix 6: account purge clears idempotency_key + verification ---- */
  it('B6. purgeAccount clears the user\'s idempotency_key + verification (OTP) rows (no FK cascade)', async () => {
    const email = `del-${runTag}-${userSeq}@example.test`;
    const me = await newUser({ email });
    const day = resolveDayBucket(new Date(), TZ);
    await makeRawMedia(me, day);

    // idempotency_key rows scoped to the user (NO FK to users → would orphan).
    await db.insert(idempotencyKeys).values({
      key: `publish:${randomUUID()}`,
      userId: me,
      endpoint: 'POST /montages/{id}/publish',
      requestHash: 'h',
      responseStatus: 200,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });
    // verification (OTP) rows keyed by the user's email identifier — both the bare
    // email and a Better-Auth prefixed form (e.g. "sign-in-otp-<email>").
    await db.insert(verification).values({
      identifier: email,
      value: 'hashed-otp-1',
      expiresAt: new Date(Date.now() + 600 * 1000),
    });
    await db.insert(verification).values({
      identifier: `sign-in-otp-${email}`,
      value: 'hashed-otp-2',
      expiresAt: new Date(Date.now() + 600 * 1000),
    });

    // Pre-state: both row sets present.
    expect(await countRows('idempotency_key', sql`user_id = ${me}`)).toBe(1);
    expect(await countRows('verification', sql`identifier like ${'%' + email}`)).toBe(2);

    const res = await purgeAccount(me, new Date().toISOString());
    expect(res.purged).toBe(true);

    // Both row sets are GONE (Fix 6 — they have no FK to users so the cascade misses them).
    expect(await countRows('idempotency_key', sql`user_id = ${me}`)).toBe(0);
    expect(await countRows('verification', sql`identifier like ${'%' + email}`)).toBe(0);
  });
});
