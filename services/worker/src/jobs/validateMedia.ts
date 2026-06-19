/**
 * `validate-media` job (§6 metadata validation hierarchy, Q4) — the gate that
 * underpins the 24h-deletion promise: only media genuinely captured in TODAY's
 * 4am→4am window may live in today's bucket.
 *
 * For each uploaded raw item we:
 *   1. Re-read the canonical row (self-contained; never trust stale client values).
 *   2. If `captured_in_app` → AUTO-VALID (the trusted in-app camera path, §6).
 *   3. Otherwise resolve `original_timestamp` from the HIERARCHY:
 *        a. EXIF `DateTimeOriginal`            (images — via exifr)
 *        b. media-library / asset creation time (client-passed device_timestamp
 *           used as the media-lib proxy; videos: ffprobe `creation_time`)
 *        c. file creation time                  (S3 LastModified is unreliable as
 *           a *capture* time, so we treat the absence of a/b for a file with no
 *           embedded time as → invalid; see note below)
 *        d. none resolved → INVALID
 *   4. Check the resolved capture instant falls in the row's `day_bucket` (using
 *      the SAME shared resolver + the device tz). If not → INVALID.
 *   5. Anti-tamper: if |device_timestamp − server_receive_time| exceeds the
 *      threshold → set `device_time_suspicious=true` (does NOT itself invalidate;
 *      it's a review signal, §6).
 *   6. Persist `validation_status` + flags + `processing_status` + a non-PII
 *      `metadata_summary` (which source resolved, dims/codec presence).
 *
 * On ANY unexpected error we mark the item invalid/failed and RETURN normally —
 * the worker must never crash on a single bad item (§10 "failed jobs retry").
 */
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import exifr from 'exifr';
import { dailyMediaItems } from '@twenty4/contracts/db';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import { db } from '../db.js';
import { env } from '../env.js';
import { buckets, downloadObject } from '../storage.js';
import { FFPROBE_PATH } from '../media/probe.js';
import { execa } from 'execa';

/** What resolved the capture time (recorded in metadata_summary, non-PII). */
type TimeSource = 'exif' | 'media_library' | 'video_creation_time' | 'file' | 'none';

export interface ValidateMediaResult {
  mediaId: string;
  validationStatus: 'valid' | 'invalid';
  timeSource: TimeSource;
  deviceTimeSuspicious: boolean;
  /** Present when invalid → the reason (for logs/tests; never user content). */
  reason?: string;
}

/**
 * Extract a video's `creation_time` (ffprobe format/stream tags) → a Date, or null.
 * Standalone ffprobe call (the renderer's `probe()` doesn't surface tags).
 */
async function videoCreationTime(filePath: string): Promise<Date | null> {
  try {
    const { stdout } = await execa(FFPROBE_PATH, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_entries',
      'format_tags=creation_time:stream_tags=creation_time',
      filePath,
    ]);
    const json = JSON.parse(stdout) as {
      format?: { tags?: { creation_time?: string } };
      streams?: Array<{ tags?: { creation_time?: string } }>;
    };
    const raw =
      json.format?.tags?.creation_time ??
      json.streams?.find((s) => s.tags?.creation_time)?.tags?.creation_time;
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** Extract EXIF DateTimeOriginal from an image file → a Date, or null. */
async function exifDateTimeOriginal(filePath: string): Promise<Date | null> {
  try {
    // pick only the timestamp tags; exifr returns JS Dates for these.
    const out = (await exifr.parse(filePath, {
      pick: ['DateTimeOriginal', 'CreateDate'],
    })) as { DateTimeOriginal?: Date; CreateDate?: Date } | undefined;
    const d = out?.DateTimeOriginal ?? out?.CreateDate;
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/**
 * Run the validation hierarchy for one media row id. Pure-ish: reads the row,
 * downloads the object, resolves a capture time, and WRITES the verdict back.
 */
export async function validateMedia(
  mediaId: string,
  serverReceiveTime: Date,
): Promise<ValidateMediaResult> {
  const [row] = await db
    .select()
    .from(dailyMediaItems)
    .where(eq(dailyMediaItems.id, mediaId))
    .limit(1);

  if (!row) {
    // Row vanished (e.g. user deleted before validation) — nothing to do.
    return {
      mediaId,
      validationStatus: 'invalid',
      timeSource: 'none',
      deviceTimeSuspicious: false,
      reason: 'row_missing',
    };
  }

  // Anti-tamper delta (independent of the validity verdict): compare the device
  // clock at upload against when the SERVER accepted completion.
  const thresholdMs = env.DEVICE_TIME_SUSPICIOUS_MINUTES * 60 * 1000;
  const deviceTimeSuspicious = row.deviceTimestamp
    ? Math.abs(row.deviceTimestamp.getTime() - serverReceiveTime.getTime()) >
      thresholdMs
    : false;

  const deviceTz = row.deviceTimezone ?? 'UTC';

  /* ---- 2: in-app capture → auto-valid (trusted path) --------------------- */
  if (row.capturedInApp) {
    await persist(mediaId, {
      validationStatus: 'valid',
      processingStatus: 'valid',
      originalTimestamp: row.originalTimestamp ?? serverReceiveTime,
      deviceTimeSuspicious,
      metadata: {
        timeSource: 'media_library',
        capturedInApp: true,
        deviceTimeSuspicious,
      },
    });
    return {
      mediaId,
      validationStatus: 'valid',
      timeSource: 'media_library',
      deviceTimeSuspicious,
    };
  }

  /* ---- 3: gallery upload → resolve capture time via the hierarchy -------- */
  let tmp: string | undefined;
  let captureTime: Date | null = null;
  let timeSource: TimeSource = 'none';

  try {
    tmp = await mkdtemp(path.join(tmpdir(), 'twenty4-validate-'));
    const ext = path.extname(row.storagePath) || '.bin';
    const local = path.join(tmp, `media${ext}`);
    await downloadObject(buckets.raw, row.storagePath, local);

    const isImage = (row.contentType ?? row.mediaType).startsWith('image')
      ? true
      : row.mediaType === 'photo';

    // a. EXIF DateTimeOriginal (images).
    if (isImage) {
      captureTime = await exifDateTimeOriginal(local);
      if (captureTime) timeSource = 'exif';
    } else {
      // videos: ffprobe creation_time as the embedded capture time (≈ media-lib).
      captureTime = await videoCreationTime(local);
      if (captureTime) timeSource = 'video_creation_time';
    }

    // b. media-library / asset creation time (client-passed device capture time).
    //    Used when no embedded EXIF/container time is present. `original_timestamp`
    //    carries the client's best-resolved capture time (EXIF→media-lib→file),
    //    so it stands in for the device media-library creation timestamp here.
    if (!captureTime && row.originalTimestamp) {
      captureTime = row.originalTimestamp;
      timeSource = 'media_library';
    }

    // c. file creation time. S3 LastModified reflects UPLOAD time, not capture
    //    time, so it is NOT a trustworthy capture source — using it would let any
    //    old gallery file pass simply by being uploaded today. Per §6 step 4, with
    //    no EXIF / media-lib / embedded time we fall through to INVALID.
    //    (A real device file-creation timestamp, when the client can read it, is
    //    surfaced via `original_timestamp` above — handled by branch (b).)
  } catch (err) {
    // Unexpected download/parse failure → mark invalid, never crash.
    await persist(mediaId, {
      validationStatus: 'invalid',
      processingStatus: 'failed',
      deviceTimeSuspicious,
      metadata: {
        timeSource: 'none',
        error: errMessage(err),
        deviceTimeSuspicious,
      },
    });
    return {
      mediaId,
      validationStatus: 'invalid',
      timeSource: 'none',
      deviceTimeSuspicious,
      reason: 'processing_error',
    };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  // d. nothing resolved → invalid.
  if (!captureTime) {
    await persist(mediaId, {
      validationStatus: 'invalid',
      processingStatus: 'invalid',
      deviceTimeSuspicious,
      metadata: { timeSource: 'none', deviceTimeSuspicious },
    });
    return {
      mediaId,
      validationStatus: 'invalid',
      timeSource: 'none',
      deviceTimeSuspicious,
      reason: 'no_capture_time',
    };
  }

  /* ---- 4: capture instant must fall in the row's day_bucket -------------- */
  const captureBucket = resolveDayBucket(
    captureTime,
    deviceTz,
    env.DAY_WINDOW_OFFSET_HOURS,
  );
  const rowBucket = row.dayBucket; // already a YYYY-MM-DD string (date column)
  const inWindow = captureBucket === rowBucket;

  await persist(mediaId, {
    validationStatus: inWindow ? 'valid' : 'invalid',
    processingStatus: inWindow ? 'valid' : 'invalid',
    originalTimestamp: captureTime,
    deviceTimeSuspicious,
    metadata: {
      timeSource,
      captureBucket,
      rowBucket,
      inWindow,
      deviceTimeSuspicious,
    },
  });

  return {
    mediaId,
    validationStatus: inWindow ? 'valid' : 'invalid',
    timeSource,
    deviceTimeSuspicious,
    reason: inWindow ? undefined : 'out_of_window',
  };
}

/** Persist the verdict + flags + non-PII metadata summary. */
async function persist(
  mediaId: string,
  v: {
    validationStatus: 'valid' | 'invalid';
    processingStatus: 'valid' | 'invalid' | 'failed';
    originalTimestamp?: Date;
    deviceTimeSuspicious: boolean;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .update(dailyMediaItems)
    .set({
      validationStatus: v.validationStatus,
      processingStatus: v.processingStatus,
      deviceTimeSuspicious: v.deviceTimeSuspicious,
      ...(v.originalTimestamp ? { originalTimestamp: v.originalTimestamp } : {}),
      metadataSummary: v.metadata,
    })
    .where(eq(dailyMediaItems.id, mediaId));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
