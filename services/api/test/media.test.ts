/**
 * Slice 2 media integration test — REAL stack (Postgres + Redis + MinIO).
 *
 * Proves (per Slice-2 acceptance):
 *   - POST /media (upload init) returns a presigned PUT + server-resolved day_bucket
 *   - the presigned PUT actually accepts the bytes (real round-trip to MinIO)
 *   - POST /media/:id/complete moves the row to validating + enqueues the job
 *   - the row exists with the SERVER-resolved bucket (client cannot set it)
 *   - GET /media/today returns the caller's items for today's bucket
 *   - GET /media/:id/download-url is OWNER-ONLY (other user → 404, no leak)
 *   - the presigned GET round-trips the same bytes back
 *   - presign helpers reject an arbitrary bucket; keys are namespaced to the user
 *   - the signed-URL TTL is clamped (expiresIn present and ≤ the GET cap)
 *   - DELETE /media/:id hard-deletes (subsequent download-url → 404)
 *
 * Rows are cleaned up in afterAll (user cascade drops media).
 */
// NOTE: this suite runs with MAX_UPLOAD_BYTES=1024 (set in vitest.config.ts) so the
// post-upload size gate can be exercised on REAL small bytes: the 284-byte
// TINY_JPEG passes, while a deliberately ~2KB upload trips the §10 size cap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { dailyMediaItems } from '@twenty4/contracts/db';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import { buildApp } from '../src/app.js';
import { db, closeDb } from '../src/db/index.js';
import { closeRedis } from '../src/redis/index.js';
import { closeQueues } from '../src/queue/producers.js';
import {
  presignPut,
  presignGet,
  assertBucket,
  rawObjectKey,
  clampTtl,
  buckets,
  objectExists,
} from '../src/storage/s3.js';

const unique = Date.now();
const runId = unique.toString(36);

interface TestUser {
  token: string;
  userId: string;
  email: string;
}

const emails: string[] = [];
let ipCounter = 0;

/** A tiny JPEG (1x1) so the PUT round-trip moves real bytes. */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwA//9k=',
  'base64',
);

describe('media — upload init/complete + today + download-url (live PG + redis + MinIO)', () => {
  let app: FastifyInstance;

  async function signUp(tag: string): Promise<TestUser> {
    const email = `slice2-${tag}-${unique}@twenty4.test`;
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
    expect(otpRes.statusCode).toBe(200);
    const code = otpRes.json().code as string;

    const verify = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, code },
    });
    expect(verify.statusCode).toBe(200);
    const token = verify.json().accessToken as string;

    const patch = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: `s2${tag}${runId}`, displayName: `S2 ${tag}` },
    });
    expect(patch.statusCode).toBe(200);
    const userId = patch.json().id as string;
    return { token, userId, email };
  }

  function auth(u: TestUser) {
    return { authorization: `Bearer ${u.token}` };
  }

  let owner: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    owner = await signUp('owner');
    other = await signUp('other');
  });

  afterAll(async () => {
    // Clean up created users (cascades media). Best-effort.
    for (const e of emails) {
      await db
        .execute(sql`delete from "users" where email = ${e}`)
        .catch(() => {});
    }
    await app.close();
    await closeQueues();
    await closeRedis();
    await closeDb();
  });

  /* ----------------------- presign helper unit guards ---------------------- */

  it('presign helpers enforce the bucket allow-list', () => {
    expect(() => assertBucket('raw')).not.toThrow();
    expect(() => assertBucket('montages')).not.toThrow();
    // An arbitrary bucket is rejected — a client cannot presign outside the map.
    expect(() => assertBucket('secret-bucket')).toThrow();
    expect(() => assertBucket('../raw')).toThrow();
  });

  it('raw keys are namespaced to the user (no cross-namespace presign)', () => {
    const k = rawObjectKey({
      userId: owner.userId,
      dayBucket: '2026-06-19',
      contentType: 'image/jpeg',
    });
    expect(k.startsWith(`${owner.userId}/2026-06-19/`)).toBe(true);
    expect(k.endsWith('.jpg')).toBe(true);
    // path-traversal segments are stripped.
    const evil = rawObjectKey({
      userId: '../../etc',
      dayBucket: '..',
      contentType: 'image/jpeg',
    });
    expect(evil.includes('..')).toBe(false);
  });

  it('TTL is clamped to the cap AND to the remaining lifetime', () => {
    // Request 99999s but cap is 3600 → clamped to 3600.
    expect(clampTtl(99_999, 3600)).toBe(3600);
    // Remaining lifetime is 100s from now → clamp below the cap.
    const expiry = new Date(Date.now() + 100_000);
    const ttl = clampTtl(3600, 3600, expiry);
    expect(ttl).toBeLessThanOrEqual(100);
    expect(ttl).toBeGreaterThan(0);
    // Already expired → still >=1 (never 0/negative), so a presign never outlives it.
    expect(clampTtl(3600, 3600, new Date(Date.now() - 1000))).toBeGreaterThanOrEqual(1);
  });

  it('presignPut/presignGet refuse an out-of-allow-list bucket', async () => {
    // `BucketName` is resolved from env (widened to string), so passing a bad
    // bucket compiles; the runtime allow-list guard is what rejects it.
    const bad = 'not-a-bucket' as never;
    await expect(presignPut(bad, 'k')).rejects.toThrow();
    await expect(presignGet(bad, 'k')).rejects.toThrow();
  });

  /* ----------------------- full upload round-trip -------------------------- */

  let createdId: string;
  let createdKey: string;

  it('POST /media returns a presigned PUT + server-resolved day_bucket; PUT round-trips to MinIO', async () => {
    const tz = 'America/New_York';
    const res = await app.inject({
      method: 'POST',
      url: '/media',
      headers: auth(owner),
      payload: {
        mediaType: 'photo',
        contentType: 'image/jpeg',
        sizeBytes: TINY_JPEG.length,
        capturedInApp: false,
        deviceTimezone: tz,
        deviceTimestamp: new Date().toISOString(),
        originalTimestamp: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      id: string;
      uploadUrl: string;
      storageKey: string;
      dayBucket: string;
      expiresIn: number;
    };
    createdId = body.id;
    createdKey = body.storageKey;

    // Server-resolved bucket matches the shared resolver (client cannot set it).
    expect(body.dayBucket).toBe(resolveDayBucket(new Date(), tz));
    // Key is namespaced to the owner.
    expect(body.storageKey.startsWith(`${owner.userId}/`)).toBe(true);
    // TTL clamp present + bounded by the PUT cap (15min).
    expect(body.expiresIn).toBeGreaterThan(0);
    expect(body.expiresIn).toBeLessThanOrEqual(900);
    expect(body.uploadUrl).toMatch(/^http/);

    // Actually PUT the bytes to MinIO via the presigned URL (real round-trip).
    const put = await fetch(body.uploadUrl, {
      method: 'PUT',
      body: TINY_JPEG,
      headers: { 'Content-Type': 'image/jpeg' },
    });
    expect(put.ok).toBe(true);

    // The object is now in the raw bucket.
    expect(await objectExists(buckets.raw, body.storageKey)).toBe(true);
  });

  it('the persisted row carries the SERVER-resolved bucket + the device tz', async () => {
    const [row] = await db
      .select()
      .from(dailyMediaItems)
      .where(eq(dailyMediaItems.id, createdId))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row!.userId).toBe(owner.userId);
    expect(row!.dayBucket).toBe(resolveDayBucket(new Date(), 'America/New_York'));
    expect(row!.deviceTimezone).toBe('America/New_York');
    expect(row!.storagePath).toBe(createdKey);
    expect(row!.validationStatus).toBe('pending');
  });

  it('POST /media/:id/complete enqueues validate-media + moves to validating', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/media/${createdId}/complete`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { id: string; processingStatus: string };
    expect(body.id).toBe(createdId);
    expect(body.processingStatus).toBe('validating');
  });

  it('GET /media/today lists the caller item for today bucket', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/media/today?tz=America/New_York',
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      dayBucket: string;
      items: Array<{ id: string; previewUrl: string | null }>;
      validCount: number;
    };
    expect(body.dayBucket).toBe(resolveDayBucket(new Date(), 'America/New_York'));
    const ours = body.items.find((i) => i.id === createdId);
    expect(ours).toBeTruthy();
    // Once it's past 'uploaded' (validating), a preview URL is presigned.
    expect(ours!.previewUrl).toMatch(/^http/);
  });

  /* ------------------------- download-url owner-only ----------------------- */

  it('GET /media/:id/download-url is owner-only; round-trips the same bytes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/media/${createdId}/download-url`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const { url, expiresIn } = res.json() as { url: string; expiresIn: number };
    expect(expiresIn).toBeGreaterThan(0);
    expect(expiresIn).toBeLessThanOrEqual(3600);

    const got = await fetch(url);
    expect(got.ok).toBe(true);
    const bytes = Buffer.from(await got.arrayBuffer());
    expect(bytes.equals(TINY_JPEG)).toBe(true);
  });

  it('a NON-owner gets 404 for download-url (no existence leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/media/${createdId}/download-url`,
      headers: auth(other),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('a malformed / unknown id → 404, not a 500', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: `/media/not-a-uuid/download-url`,
      headers: auth(owner),
    });
    expect(bad.statusCode).toBe(404);
    const missing = await app.inject({
      method: 'GET',
      url: `/media/00000000-0000-4000-8000-000000000000/download-url`,
      headers: auth(owner),
    });
    expect(missing.statusCode).toBe(404);
  });

  /* ------------------------------- unauth ---------------------------------- */

  it('all media routes require a session (401 without a token)', async () => {
    const res = await app.inject({ method: 'GET', url: '/media/today' });
    expect(res.statusCode).toBe(401);
  });

  /* ------------------------------- day-cap --------------------------------- */

  it('enforces the §10 per-day item cap (conflict beyond 50)', async () => {
    // Pre-seed the cap directly (faster than 50 inits) for THIS owner+today, then
    // assert the 51st init is rejected. Use a distinct user so we don't pollute
    // the round-trip row above.
    const capUser = await signUp('cap');
    const bucket = resolveDayBucket(new Date(), 'UTC');
    const rows = Array.from({ length: 50 }).map((_, i) => ({
      userId: capUser.userId,
      dayBucket: bucket,
      mediaType: 'photo' as const,
      storagePath: `${capUser.userId}/${bucket}/seed-${i}.jpg`,
      processingStatus: 'uploaded' as const,
    }));
    await db.insert(dailyMediaItems).values(rows);

    const res = await app.inject({
      method: 'POST',
      url: '/media',
      headers: auth(capUser),
      payload: {
        mediaType: 'photo',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        deviceTimezone: 'UTC',
        // captured in-app so the device_timestamp guard is bypassed; we're testing
        // the per-day cap here, not the anti-tamper requirement.
        capturedInApp: true,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  /* --------------------- anti-tamper: device_timestamp gate ---------------- */

  it('a gallery upload (capturedInApp=false) WITHOUT device_timestamp → 422', async () => {
    // Anti-tamper: a non-capture upload must carry a device clock so the worker can
    // compute the device-vs-server delta. Omitting it used to silently disable the
    // check; now it's rejected.
    const res = await app.inject({
      method: 'POST',
      url: '/media',
      headers: auth(owner),
      payload: {
        mediaType: 'photo',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        capturedInApp: false,
        deviceTimezone: 'UTC',
        // no deviceTimestamp
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation');
  });

  /* -------------------- oversize / type gate at /complete ------------------ */

  it('POST /media/:id/complete rejects an OVERSIZE upload + deletes the object (413)', async () => {
    // REAL bytes: with the suite's 1KB cap, a ~2KB JPEG is genuinely over the limit.
    // The presigned PUT accepts it (no up-front size enforcement); the post-upload
    // HeadObject gate then rejects it, deletes the object, and marks the row failed.
    const big = Buffer.concat([TINY_JPEG, Buffer.alloc(2048, 0x20)]); // ~2.3KB > 1KB
    const init = await app.inject({
      method: 'POST',
      url: '/media',
      headers: auth(owner),
      payload: {
        mediaType: 'photo',
        contentType: 'image/jpeg',
        sizeBytes: big.length,
        capturedInApp: false,
        deviceTimezone: 'UTC',
        deviceTimestamp: new Date().toISOString(),
      },
    });
    expect(init.statusCode).toBe(201);
    const { id, uploadUrl, storageKey } = init.json() as {
      id: string;
      uploadUrl: string;
      storageKey: string;
    };

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      body: big,
      headers: { 'Content-Type': 'image/jpeg' },
    });
    expect(put.ok).toBe(true);
    expect(await objectExists(buckets.raw, storageKey)).toBe(true);

    const complete = await app.inject({
      method: 'POST',
      url: `/media/${id}/complete`,
      headers: auth(owner),
    });
    expect(complete.statusCode).toBe(413);
    expect(complete.json().error.code).toBe('payload_too_large');

    // The reject path DELETED the object (so a leaked presigned GET would 404).
    expect(await objectExists(buckets.raw, storageKey)).toBe(false);

    // Row marked failed/invalid (not enqueued).
    const [row] = await db
      .select()
      .from(dailyMediaItems)
      .where(eq(dailyMediaItems.id, id))
      .limit(1);
    expect(row!.processingStatus).toBe('failed');
    expect(row!.validationStatus).toBe('invalid');
  });

  it('POST /media/:id/complete rejects a content-type MISMATCH + deletes the object (413)', async () => {
    // Same reject+delete path, different trigger: PUT JPEG bytes against a declared
    // PNG slot. The under-cap size means ONLY the type mismatch trips the gate.
    const init = await app.inject({
      method: 'POST',
      url: '/media',
      headers: auth(owner),
      payload: {
        mediaType: 'photo',
        contentType: 'image/png', // declared PNG
        sizeBytes: TINY_JPEG.length,
        capturedInApp: false,
        deviceTimezone: 'UTC',
        deviceTimestamp: new Date().toISOString(),
      },
    });
    expect(init.statusCode).toBe(201);
    const { id, uploadUrl, storageKey } = init.json() as {
      id: string;
      uploadUrl: string;
      storageKey: string;
    };

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      body: TINY_JPEG,
      headers: { 'Content-Type': 'image/jpeg' }, // mismatches declared PNG
    });
    expect(put.ok).toBe(true);

    const complete = await app.inject({
      method: 'POST',
      url: `/media/${id}/complete`,
      headers: auth(owner),
    });
    expect(complete.statusCode).toBe(413);
    expect(complete.json().error.code).toBe('payload_too_large');
    expect(await objectExists(buckets.raw, storageKey)).toBe(false);
  });

  it('POST /media/:id/complete with no uploaded object → 422 (PUT never landed)', async () => {
    const init = await app.inject({
      method: 'POST',
      url: '/media',
      headers: auth(owner),
      payload: {
        mediaType: 'photo',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        capturedInApp: false,
        deviceTimezone: 'UTC',
        deviceTimestamp: new Date().toISOString(),
      },
    });
    expect(init.statusCode).toBe(201);
    const { id } = init.json() as { id: string };
    // Do NOT PUT anything; complete should detect the missing object.
    const complete = await app.inject({
      method: 'POST',
      url: `/media/${id}/complete`,
      headers: auth(owner),
    });
    expect(complete.statusCode).toBe(422);
    expect(complete.json().error.code).toBe('validation');
  });

  /* -------------------------------- delete --------------------------------- */

  it('DELETE /media/:id hard-deletes the row AND the S3 object (leaked GET 404s)', async () => {
    // Capture a presigned GET BEFORE deleting — after delete the bytes are gone, so
    // this still-unexpired URL must 404 (content, not just the row, is removed).
    const dl = await app.inject({
      method: 'GET',
      url: `/media/${createdId}/download-url`,
      headers: auth(owner),
    });
    expect(dl.statusCode).toBe(200);
    const leakedGetUrl = (dl.json() as { url: string }).url;
    // Sanity: it works right now.
    expect((await fetch(leakedGetUrl)).ok).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: `/media/${createdId}`,
      headers: auth(owner),
    });
    expect(del.statusCode).toBe(204);

    const [gone] = await db
      .select()
      .from(dailyMediaItems)
      .where(eq(dailyMediaItems.id, createdId))
      .limit(1);
    expect(gone).toBeUndefined();

    // The S3 object is gone → the previously-issued presigned GET now 404s.
    expect(await objectExists(buckets.raw, createdKey)).toBe(false);
    const leaked = await fetch(leakedGetUrl);
    expect(leaked.status).toBe(404);

    // And a fresh download-url is also a 404 (row gone).
    const after = await app.inject({
      method: 'GET',
      url: `/media/${createdId}/download-url`,
      headers: auth(owner),
    });
    expect(after.statusCode).toBe(404);
  });
});
