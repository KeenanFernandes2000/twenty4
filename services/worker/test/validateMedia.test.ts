/**
 * Slice 2 validate-media worker test — REAL stack (Postgres + MinIO) on REAL bytes
 * (real JPEG with embedded EXIF via sharp; real ffmpeg-encoded MP4 with a
 * container creation_time). Exercises the §6 validation HIERARCHY end-to-end.
 *
 * Cases:
 *   1. JPEG with EXIF DateTimeOriginal INSIDE today's window → VALID (source=exif).
 *   2. JPEG with EXIF DateTimeOriginal DAYS AGO              → INVALID (out_of_window).
 *   3. In-app capture (captured_in_app=true)                → AUTO-VALID (skips hierarchy).
 *   4. Tampered device clock (large delta)                  → device_time_suspicious=true.
 *   5. No EXIF, no client timestamp                          → INVALID (no_capture_time).
 *   6. Video MP4 with a container creation_time in-window    → VALID (source=video_creation_time).
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

/** Make a JPEG buffer; optionally embed an EXIF DateTimeOriginal. */
async function makeJpeg(dto?: Date): Promise<Buffer> {
  let img = sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 120, g: 80, b: 200 },
    },
  }).jpeg();
  if (dto) {
    img = img.withExif({ IFD2: { DateTimeOriginal: exifStamp(dto) } });
  }
  return img.toBuffer();
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
      deviceTimezone: TZ,
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

describe('validate-media — §6 validation hierarchy on real bytes (live PG + MinIO)', () => {
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'twenty4-vm-test-'));
    // The user_id FK requires a real users row — insert a minimal one.
    await db.execute(
      // citext username unique; keep it short + unique to this run.
      // password/status defaults handle the rest.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('drizzle-orm')).sql`insert into users (id, username, display_name, account_status)
        values (${userId}, ${'vm' + userId.slice(0, 8)}, ${'VM Test'}, 'active')`,
    );
  });

  afterAll(async () => {
    // Cascade: deleting the user drops its media rows.
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
    // Mid-day capture so a few-hour EXIF-local interpretation can't cross the 4am edge.
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

  it('3. in-app capture (captured_in_app=true) → AUTO-VALID, skips the hierarchy', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    // No EXIF — would be invalid if not for the trusted-capture short-circuit.
    const jpeg = await makeJpeg();
    const key = await putRaw(bucket, 'jpg', jpeg);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storageKey: key,
      capturedInApp: true,
    });

    const res = await validateMedia(id, new Date());
    expect(res.validationStatus).toBe('valid');

    const row = await reload(id);
    expect(row.validationStatus).toBe('valid');
    expect(row.capturedInApp).toBe(true);
    expect((row.metadataSummary as { capturedInApp?: boolean }).capturedInApp).toBe(true);
  });

  it('4. tampered device clock (large delta) → device_time_suspicious=true', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const capture = new Date(now);
    capture.setHours(14, 30, 0, 0);
    const jpeg = await makeJpeg(capture);
    const key = await putRaw(bucket, 'jpg', jpeg);
    // Device clock 10 hours off from the server receive time → over the 60-min threshold.
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

  it('5. no EXIF + no client timestamp → INVALID (no_capture_time)', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    const jpeg = await makeJpeg(); // no EXIF
    const key = await putRaw(bucket, 'jpg', jpeg);
    const id = await insertRow({
      dayBucket: bucket,
      mediaType: 'photo',
      contentType: 'image/jpeg',
      storageKey: key,
    });

    const res = await validateMedia(id, new Date());
    expect(res.validationStatus).toBe('invalid');
    expect(res.reason).toBe('no_capture_time');
  });

  it('6. video MP4 with a container creation_time in-window → VALID (source=video_creation_time)', async () => {
    const now = new Date();
    const bucket = resolveDayBucket(now, TZ);
    // Encode a short MP4, then stamp its container creation_time to a mid-day
    // instant today via ffmpeg metadata. (ffprobe reads it back as creation_time.)
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
});
