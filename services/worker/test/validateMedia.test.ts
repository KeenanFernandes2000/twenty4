/**
 * validate-media worker test — REAL stack (Postgres + MinIO) on REAL bytes (real
 * JPEG with embedded EXIF via sharp; real ffmpeg-encoded MP4 with a container
 * creation_time). Exercises the HARDENED Phase-1 freshness model end-to-end.
 *
 * KEY MODEL (see validateMedia.ts header):
 *   - A RELIABLE embedded capture time (EXIF DateTimeOriginal / container
 *     creation_time) is anti-backdating: if present it MUST fall in today's window
 *     or the item is INVALID — regardless of captured_in_app or any client time.
 *   - captured_in_app is NO LONGER a blanket bypass. With no embedded time it makes
 *     an item VALID-but-`capture_time_unverified`; with OLD embedded time it's still
 *     INVALID.
 *   - a gallery pick (captured_in_app=false) with no embedded time → INVALID.
 *   - a client-passed original_timestamp can only RAISE suspicion (old → invalid),
 *     never validate on its own.
 *
 * Cases:
 *   1.  JPEG EXIF in today's window                          → VALID (source=exif).
 *   2.  JPEG EXIF days ago                                   → INVALID (out_of_window).
 *   3.  in-app capture, NO EXIF                              → VALID + capture_time_unverified.
 *   4.  tampered device clock (large delta)                 → device_time_suspicious=true.
 *   5.  gallery pick, no EXIF, no client time               → INVALID (no_capture_time).
 *   6.  video MP4 container creation_time in-window          → VALID (source=video_creation_time).
 *   7.  CRITICAL: gallery pick captured_in_app=true + OLD EXIF → INVALID (NO bypass).
 *   8.  in-app capture + OLD EXIF                            → INVALID (embedded time wins).
 *   9.  TZ-consistency: same EXIF validates the SAME across server TZ.
 *   10. gallery pick, no EXIF, client original_timestamp OLD → INVALID (client time demoted).
 *
 * The worker job is invoked DIRECTLY (`validateMedia(id, serverReceiveTime)`) for
 * determinism; the BullMQ wiring is covered by the producer/queue + index typecheck.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { dailyMediaItems } from '@twenty4/contracts/db';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { db, closeDb } from '../src/db.js';
import { s3, buckets, closeStorage } from '../src/storage.js';
import { validateMedia } from '../src/jobs/validateMedia.js';
import { makeTestVideo } from '../src/media/index.js';

const TZ = 'UTC';
const userId = randomUUID();
const createdMediaIds: string[] = [];
let tmp: string;

/** Format a Date as an EXIF DateTimeOriginal string `YYYY:MM:DD HH:MM:SS` (local). */
function exifStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Format wall-clock fields (no Date / no tz drift) as an EXIF stamp. */
function exifStampWall(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}:${p(mo)}:${p(d)} ${p(h)}:${p(mi)}:${p(s)}`;
}

/** Make a JPEG buffer; optionally embed an EXIF DateTimeOriginal (raw string). */
async function makeJpegRaw(dtoRaw?: string): Promise<Buffer> {
  let img = sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 120, g: 80, b: 200 },
    },
  }).jpeg();
  if (dtoRaw) {
    img = img.withExif({ IFD2: { DateTimeOriginal: dtoRaw } });
  }
  return img.toBuffer();
}

/** Make a JPEG buffer; optionally embed an EXIF DateTimeOriginal from a Date. */
async function makeJpeg(dto?: Date): Promise<Buffer> {
  return makeJpegRaw(dto ? exifStamp(dto) : undefined);
}

/** Upload bytes to the raw bucket under a namespaced key; return the key. */
async function putRaw(bucketDay: string, ext: string, body: Buffer): Promise<string> {
  const key = `${userId}/${bucketDay}/${randomUUID()}.${ext}`;
  await s3.send(
    new PutObjectCommand({ Bucket: buckets.raw, Key: key, Body: body }),
  );
  return key;
}

/** Insert a daily_media_item row (uploaded, pending). Returns its id. */
async function insertRow(args: {
  dayBucket: string;
  mediaType: 'photo' | 'video';
  contentType: string;
  storageKey: string;
  capturedInApp?: boolean;
  deviceTimezone?: string;
  deviceTimestamp?: Date | null;
  originalTimestamp?: Date | null;
}): Promise<string> {
  const [row] = await db
    .insert(dailyMediaItems)
    .values({
      userId,
      dayBucket: args.dayBucket,
      mediaType: args.mediaType,
      contentType: args.contentType,
      storagePath: args.storageKey,
      capturedInApp: args.capturedInApp ?? false,
      deviceTimezone: args.deviceTimezone ?? TZ,
      deviceTimestamp: args.deviceTimestamp ?? null,
      originalTimestamp: args.originalTimestamp ?? null,
      validationStatus: 'pending',
      processingStatus: 'validating',
    })
    .returning();
  createdMediaIds.push(row!.id);
  return row!.id;
}

async function reload(id: string) {
  const [row] = await db
    .select()
    .from(dailyMediaItems)
    .where(eq(dailyMediaItems.id, id))
    .limit(1);
  return row!;
}

describe('validate-media — hardened freshness model on real bytes (live PG + MinIO)', () => {
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'twenty4-vm-test-'));
    // The user_id FK requires a real users row — insert a minimal one.
    await db.execute(
      (await import('drizzle-orm')).sql`insert into users (id, username, display_name, account_status)
        values (${userId}, ${'vm' + userId.slice(0, 8)}, ${'VM Test'}, 'active')`,
    );
  });

  afterAll(async () => {
    await db
      .execute(
        (await import('drizzle-orm')).sql`delete from users where id = ${userId}`,
      )
      .catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    await closeDb();
    closeStorage();
  });

  it('1. JPEG with EXIF DateTimeOriginal in today’s window → VALID (source=exif)', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const capture = new Date(now);
    capture.setHours(14, 30, 0, 0);
    const jpeg = await makeJpeg(capture);
    const key = await putRaw(bucket, 'jpg', jpeg);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storageKey: key,
    });

    const res = await validateMedia(id, new Date());
    expect(res.validationStatus).toBe('valid');
    expect(res.timeSource).toBe('exif');
    expect(res.captureTimeUnverified).toBe(false);

    const row = await reload(id);
    expect(row.validationStatus).toBe('valid');
    expect(row.processingStatus).toBe('valid');
    expect(row.originalTimestamp).toBeTruthy();
    expect((row.metadataSummary as { timeSource?: string }).timeSource).toBe('exif');
  });

  it('2. JPEG with EXIF DateTimeOriginal DAYS AGO → INVALID (out_of_window)', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const daysAgo = new Date(now.getTime() - 5 * 24 * 3600 * 1000);
    daysAgo.setHours(14, 30, 0, 0);
    const jpeg = await makeJpeg(daysAgo);
    const key = await putRaw(bucket, 'jpg', jpeg);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storageKey: key,
    });

    const res = await validateMedia(id, new Date());
    expect(res.validationStatus).toBe('invalid');
    expect(res.reason).toBe('out_of_window');
    expect(res.timeSource).toBe('exif');

    const row = await reload(id);
    expect(row.validationStatus).toBe('invalid');
    expect(row.processingStatus).toBe('invalid');
  });

  it('3. in-app capture, NO EXIF → VALID + capture_time_unverified (asserted, not proven)', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const jpeg = await makeJpeg(); // no EXIF
    const key = await putRaw(bucket, 'jpg', jpeg);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storageKey: key,
      capturedInApp: true,
      deviceTimestamp: now,
    });

    const res = await validateMedia(id, now);
    expect(res.validationStatus).toBe('valid');
    expect(res.captureTimeUnverified).toBe(true);
    expect(res.reason).toBe('capture_time_unverified');

    const row = await reload(id);
    expect(row.validationStatus).toBe('valid');
    expect(row.capturedInApp).toBe(true);
    expect(
      (row.metadataSummary as { captureTimeUnverified?: boolean }).captureTimeUnverified,
    ).toBe(true);
  });

  it('4. tampered device clock (large delta) → device_time_suspicious=true', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const capture = new Date(now);
    capture.setHours(14, 30, 0, 0);
    const jpeg = await makeJpeg(capture);
    const key = await putRaw(bucket, 'jpg', jpeg);
    const deviceClock = new Date(now.getTime() + 10 * 3600 * 1000);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storageKey: key,
      deviceTimestamp: deviceClock,
    });

    const res = await validateMedia(id, now);
    expect(res.deviceTimeSuspicious).toBe(true);
    // The item is still EXIF-valid; tamper is a flag, not a verdict.
    expect(res.validationStatus).toBe('valid');

    const row = await reload(id);
    expect(row.deviceTimeSuspicious).toBe(true);
  });

  it('5. gallery pick, no EXIF, no client time → INVALID (no_capture_time)', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const jpeg = await makeJpeg(); // no EXIF
    const key = await putRaw(bucket, 'jpg', jpeg);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storageKey: key,
      capturedInApp: false,
      deviceTimestamp: now,
    });

    const res = await validateMedia(id, now);
    expect(res.validationStatus).toBe('invalid');
    expect(res.reason).toBe('no_capture_time');
  });

  it('6. video MP4 with a container creation_time in-window → VALID (source=video_creation_time)', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const rawVid = path.join(tmp, 'raw.mp4');
    await makeTestVideo(rawVid, { durationSec: 1, width: 64, height: 64 });
    const capture = new Date(now);
    capture.setHours(14, 30, 0, 0);
    const stamped = path.join(tmp, 'stamped.mp4');
    const { execa } = await import('execa');
    await execa(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      rawVid,
      '-c',
      'copy',
      '-metadata',
      `creation_time=${capture.toISOString()}`,
      stamped,
    ]);
    const body = await readFile(stamped);
    const key = await putRaw(bucket, 'mp4', body);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'video',
      contentType: 'video/mp4',
      storageKey: key,
    });

    const res = await validateMedia(id, new Date());
    expect(res.validationStatus).toBe('valid');
    expect(res.timeSource).toBe('video_creation_time');

    const row = await reload(id);
    expect(row.validationStatus).toBe('valid');
  });

  it('7. CRITICAL — gallery pick with captured_in_app=true but OLD EXIF → INVALID (no bypass)', async () => {
    // The forged case: a client uploads an OLD gallery photo and lies
    // captured_in_app=true (and even sends a fresh client original_timestamp). The
    // embedded EXIF betrays it → must be INVALID. The old code auto-VALIDed this.
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const old = new Date(now.getTime() - 9 * 24 * 3600 * 1000);
    old.setHours(11, 0, 0, 0);
    const jpeg = await makeJpeg(old); // OLD embedded EXIF
    const key = await putRaw(bucket, 'jpg', jpeg);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storageKey: key,
      capturedInApp: true, // forged claim
      deviceTimestamp: now,
      originalTimestamp: now, // forged-fresh client time (must NOT save it)
    });

    const res = await validateMedia(id, now);
    expect(res.validationStatus).toBe('invalid');
    expect(res.reason).toBe('out_of_window');
    expect(res.timeSource).toBe('exif');

    const row = await reload(id);
    expect(row.validationStatus).toBe('invalid');
  });

  it('8. in-app capture but OLD embedded EXIF → INVALID (embedded time wins over the flag)', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const old = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
    old.setHours(9, 0, 0, 0);
    const jpeg = await makeJpeg(old);
    const key = await putRaw(bucket, 'jpg', jpeg);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storageKey: key,
      capturedInApp: true,
      deviceTimestamp: now,
    });

    const res = await validateMedia(id, now);
    expect(res.validationStatus).toBe('invalid');
    expect(res.reason).toBe('out_of_window');
    expect(res.captureTimeUnverified).toBe(false);
  });

  it('9. TZ-consistency — the SAME EXIF validates identically regardless of server TZ', async () => {
    // Device tz = America/New_York. A mid-day wall-clock capture today, expressed as
    // a tz-LESS EXIF string. The verdict must be identical whether the worker runs
    // in UTC, NY, or Kolkata — proving the wall clock is anchored to the DEVICE tz,
    // not the server process tz (the HIGH bug).
    const deviceTz = 'America/New_York';
    const now = new Date();
    const bucket = resolveDayBucket(now, deviceTz);
    // Build the EXIF wall clock from `now`'s ACTUAL device-local wall clock (same
    // instant), so the EXIF capture is guaranteed to land in the SAME bucket as the
    // row regardless of where `now` sits relative to the 4am rollover. Derived via
    // Intl in the DEVICE tz (independent of the server process tz).
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: deviceTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const exifRaw = exifStampWall(
      get('year'),
      get('month'),
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );

    const jpeg = await makeJpegRaw(exifRaw);
    const key = await putRaw(bucket, 'jpg', jpeg);

    const originalTz = process.env.TZ;
    const results: Array<{ tz: string; status: string; bucketUsed: string }> = [];
    try {
      for (const serverTz of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
        process.env.TZ = serverTz;
        const id = await insertRow({
          dayBucket: bucket,
          mediaType: 'photo',
          contentType: 'image/jpeg',
          storageKey: key,
          deviceTimezone: deviceTz,
          deviceTimestamp: now,
        });
        const res = await validateMedia(id, now);
        const row = await reload(id);
        results.push({
          tz: serverTz,
          status: res.validationStatus,
          bucketUsed: (row.metadataSummary as { captureBucket?: string }).captureBucket ?? '',
        });
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }

    // All three runs agree: VALID, same resolved capture bucket = the device-tz bucket.
    expect(results.every((r) => r.status === 'valid')).toBe(true);
    expect(new Set(results.map((r) => r.bucketUsed)).size).toBe(1);
    expect(results[0]!.bucketUsed).toBe(bucket);
  });

  it('10. gallery pick, no EXIF, client original_timestamp OLD → INVALID (client time demoted)', async () => {
    // No embedded time; the only timestamp is a client-supplied OLD one. It must NOT
    // validate the item — and being old, it actively invalidates (backdating tell).
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const old = new Date(now.getTime() - 4 * 24 * 3600 * 1000);
    const jpeg = await makeJpeg(); // no EXIF
    const key = await putRaw(bucket, 'jpg', jpeg);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storageKey: key,
      capturedInApp: false,
      deviceTimestamp: now,
      originalTimestamp: old,
    });

    const res = await validateMedia(id, now);
    expect(res.validationStatus).toBe('invalid');
    expect(res.reason).toBe('out_of_window');
  });
});
