/**
 * `validate-media` job — the gate underpinning the "today only" / 24h-deletion
 * promise: only media that genuinely belongs to TODAY's 4am→4am window may live in
 * today's bucket.
 *
 * ============================================================================
 * FRESHNESS MODEL (Phase 1) — what we trust, and why
 * ============================================================================
 * The ONLY freshness signal a client cannot forge is the SERVER clock at upload
 * time. The day_bucket was resolved server-side at upload from `new Date()` + the
 * device tz, so "this row was uploaded during today's window" is the trustworthy
 * FLOOR — every row we see here was created today by definition of being uploaded
 * today. Everything else (EXIF, container creation_time, client timestamps) is a
 * best-effort ANTI-BACKDATING signal layered on top of that floor.
 *
 * Verdict logic (in order):
 *   1. Re-read the canonical row (self-contained; never trust stale client values).
 *   2. Anti-tamper delta: |device_timestamp − server_receive_time|. A large delta
 *      sets `device_time_suspicious` (a FLAG for review, never a sole verdict).
 *   3. Resolve a RELIABLE embedded capture time, if one exists:
 *        - images: EXIF `DateTimeOriginal` (via exifr), interpreted in the device
 *          tz (see TZ note below);
 *        - videos: container `creation_time` (via ffprobe).
 *      If present, it MUST fall in the row's day_bucket → else INVALID
 *      (out_of_window). This is what catches OLD gallery files: a photo shot last
 *      week carries last week's EXIF and is rejected regardless of any client flag.
 *   4. If NO embedded capture time exists:
 *        - captured_in_app=true  → VALID, flagged `capture_time_unverified=true`.
 *          Trusted ONLY because the upload itself is fresh (server clock floor);
 *          the in-app camera path means there was no pre-existing gallery file.
 *        - captured_in_app=false → INVALID (no_capture_time). A gallery pick with
 *          no embedded time cannot be confirmed fresh; we take the STRICTER option
 *          (reject) rather than trust an unverifiable upload. See SECURITY note.
 *   5. A client-passed `original_timestamp` is DEMOTED: it may RAISE SUSPICION (if
 *      it's old → out_of_window/flag) but it can NEVER by itself make an item VALID.
 *      Embedded EXIF/container metadata is always preferred over any client time.
 *
 * `captured_in_app` is NO LONGER a blanket bypass: an in-app photo that somehow
 * carries OLD embedded EXIF is still rejected (step 3 runs first). The old code
 * auto-VALIDed any `captured_in_app=true` upload — a client-trusted boolean — which
 * let a forged gallery pick sail through. That bypass is removed.
 *
 * ============================================================================
 * EXIF TZ NOTE (HIGH) — deterministic regardless of server TZ
 * ============================================================================
 * EXIF `DateTimeOriginal` is a tz-LESS wall clock ("14:30:00", no offset). exifr's
 * auto-revived Date (and a naive `new Date(str)`) interpret it in the SERVER
 * process tz, so the derived UTC instant — and the day bucket — would SHIFT with
 * the deploy's `TZ`. We instead read the RAW string (`reviveValues:false`) and
 * interpret the wall clock in the ITEM's device tz via `zonedWallClockToUtc`
 * (DST-correct). If the camera wrote a real `OffsetTimeOriginal`, we honor it.
 * Result: the same EXIF validates identically no matter what TZ the worker runs in
 * (covered by a tz-consistency regression test that sets process.env.TZ).
 *
 * ============================================================================
 * SECURITY — ACCEPTED Phase-1 LIMITATION (tracked for Phase 2)
 * ============================================================================
 * Without CAPTURE ATTESTATION, freshness is not cryptographically provable. A
 * determined user can still forge it: a rooted device can feed the in-app camera
 * path fake frames, or strip/rewrite EXIF on a gallery file before upload. Our
 * defenses (server-clock floor, embedded-metadata anti-backdating, device-clock
 * delta) raise the cost and catch casual abuse (the common "share an old gallery
 * photo" case), but they are NOT a substitute for attestation.
 *
 * Full freshness needs a capture-attestation chain — Play Integrity / App Attest
 * or server-issued capture-session tokens binding the bytes to a live in-app
 * capture — which is OUT OF SCOPE for Phase 1 and tracked for Phase 2. We do NOT
 * fake it: items relying solely on the in-app path (no embedded time) are clearly
 * flagged `capture_time_unverified=true` so downstream consumers know freshness
 * was asserted, not proven.
 *
 * On ANY unexpected error we mark the item invalid/failed and RETURN normally — the
 * worker must never crash on a single bad item (§10 "failed jobs retry").
 */
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import exifr from 'exifr';
import { dailyMediaItems } from '@twenty4/contracts/db';
import {
  resolveDayBucket,
  zonedWallClockToUtc,
  type WallClockFields,
} from '@twenty4/contracts/dayWindow';
import { MAX_ITEM_BYTES } from '@twenty4/contracts/dto';
import { db } from '../db.js';
import { env } from '../env.js';
import { buckets, downloadObject, headObject } from '../storage.js';
import { FFPROBE_PATH } from '../media/probe.js';
import { execa } from 'execa';

/**
 * The worker-side download cap = `min(env override, §10 200MB hard limit)` — the
 * SAME ceiling the API enforces at /complete. The env can only TIGHTEN it. Used as
 * defense-in-depth so a swapped OVERSIZE object can't be fully pulled even if the
 * ETag check were somehow bypassed.
 */
const MAX_DOWNLOAD_BYTES = Math.min(env.MAX_UPLOAD_BYTES, MAX_ITEM_BYTES);

/** What resolved the capture time (recorded in metadata_summary, non-PII). */
type TimeSource = 'exif' | 'video_creation_time' | 'none';

/** Why a verdict was reached (for logs/tests; never user content). */
type Reason =
  | 'row_missing'
  | 'object_changed'
  | 'out_of_window'
  | 'no_capture_time'
  | 'capture_time_unverified'
  | 'processing_error';

export interface ValidateMediaResult {
  mediaId: string;
  validationStatus: 'valid' | 'invalid';
  timeSource: TimeSource;
  deviceTimeSuspicious: boolean;
  /**
   * True when the item is VALID only on the strength of the fresh-upload floor +
   * in-app capture, with NO embedded capture time to confirm it (Phase-1 trust,
   * not proof). Surfaced in metadata_summary for downstream consumers.
   */
  captureTimeUnverified: boolean;
  /** Present on invalid OR when valid-but-unverified — the reason (non-PII). */
  reason?: Reason;
}

/** EXIF `YYYY:MM:DD HH:MM:SS` → wall-clock fields, or null if unparseable. */
function parseExifWallClock(raw: string): WallClockFields | null {
  // EXIF DateTimeOriginal canonical form: "2026:06:19 14:30:00".
  const m =
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const fields: WallClockFields = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s),
  };
  if (Object.values(fields).some((n) => Number.isNaN(n))) return null;
  return fields;
}

/** Parse an EXIF tz offset string ("+05:30" / "-08:00" / "Z") → minutes, or null. */
function parseExifOffsetMinutes(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t === 'Z' || t === 'z') return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(t);
  if (!m) return null;
  const [, sign, hh, mm] = m;
  const mins = Number(hh) * 60 + Number(mm);
  return sign === '-' ? -mins : mins;
}

/**
 * Resolve an image's capture INSTANT from EXIF, interpreted DETERMINISTICALLY
 * (independent of the server process tz):
 *   - read the RAW (tz-less) `DateTimeOriginal` string via `reviveValues:false`
 *     so exifr does NOT interpret it in the server tz;
 *   - if the camera wrote a real `OffsetTimeOriginal`, apply that true offset;
 *   - otherwise interpret the wall clock in the item's `deviceTz`.
 * Returns the UTC `Date`, or null if no usable EXIF time exists.
 */
async function exifCaptureInstant(
  filePath: string,
  deviceTz: string,
): Promise<Date | null> {
  try {
    const out = (await exifr.parse(filePath, {
      // reviveValues:false → timestamps come back as their raw EXIF strings, so
      // exifr never reinterprets the tz-less wall clock in the server tz.
      reviveValues: false,
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTime'],
    })) as
      | {
          DateTimeOriginal?: string;
          CreateDate?: string;
          OffsetTimeOriginal?: string;
          OffsetTime?: string;
        }
      | undefined;

    const rawStamp = out?.DateTimeOriginal ?? out?.CreateDate;
    if (!rawStamp || typeof rawStamp !== 'string') return null;

    const wall = parseExifWallClock(rawStamp);
    if (!wall) return null;

    // Prefer a real embedded offset; else anchor the wall clock to the device tz.
    const offsetMin = parseExifOffsetMinutes(out?.OffsetTimeOriginal ?? out?.OffsetTime);
    if (offsetMin !== null) {
      const asUtcMs = Date.UTC(
        wall.year,
        wall.month - 1,
        wall.day,
        wall.hour,
        wall.minute,
        wall.second,
      );
      return new Date(asUtcMs - offsetMin * 60 * 1000);
    }
    return zonedWallClockToUtc(wall, deviceTz);
  } catch {
    return null;
  }
}

/**
 * Extract a video's `creation_time` (ffprobe format/stream tags) → a Date, or null.
 * Container `creation_time` is written as a real ISO instant (usually UTC `Z`), so
 * unlike EXIF it is NOT tz-ambiguous — `new Date(iso)` is deterministic here.
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

/**
 * Run the freshness model for one media row id. Reads the row, downloads the
 * object, resolves a RELIABLE embedded capture time, and WRITES the verdict back.
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
      captureTimeUnverified: false,
      reason: 'row_missing',
    };
  }

  // Anti-tamper delta (independent of the validity verdict): compare the device
  // clock at upload against when the SERVER accepted completion. A missing
  // device_timestamp is treated as SUSPICIOUS — the API requires it on non-capture
  // uploads, so its absence on a gallery pick is itself a tamper signal.
  const thresholdMs = env.DEVICE_TIME_SUSPICIOUS_MINUTES * 60 * 1000;
  const deviceTimeSuspicious = row.deviceTimestamp
    ? Math.abs(row.deviceTimestamp.getTime() - serverReceiveTime.getTime()) >
      thresholdMs
    : !row.capturedInApp; // missing clock on a gallery pick → suspicious.

  const deviceTz = row.deviceTimezone ?? 'UTC';
  const rowBucket = row.dayBucket; // already a YYYY-MM-DD string (date column)

  /* ---- TOCTOU pin: the object must be UNCHANGED since /complete ----------- */
  // The presigned PUT stays reusable until its TTL, so a client could re-PUT a
  // swapped/oversize object to the same key AFTER passing the size/type gate at
  // /complete. We re-Head here and require the current ETag to equal the one
  // /complete pinned on the row. A mismatch (or a now-missing object) → the bytes
  // we'd process are NOT the validated ones → mark invalid/failed and DO NOT
  // download/process. (Rows from before this column existed have a null pin; we
  // can only enforce when a pin was recorded.)
  if (row.objectEtag) {
    const head = await headObject(buckets.raw, row.storagePath);
    const currentEtag = head?.etag ?? null;
    if (currentEtag !== row.objectEtag) {
      await persist(mediaId, {
        validationStatus: 'invalid',
        processingStatus: 'failed',
        deviceTimeSuspicious,
        captureTimeUnverified: false,
        metadata: {
          timeSource: 'none',
          reason: 'object_changed',
          pinnedEtag: row.objectEtag,
          currentEtag,
          deviceTimeSuspicious,
        },
      });
      return {
        mediaId,
        validationStatus: 'invalid',
        timeSource: 'none',
        deviceTimeSuspicious,
        captureTimeUnverified: false,
        reason: 'object_changed',
      };
    }
  }

  /* ---- resolve a RELIABLE embedded capture time (anti-backdating) -------- */
  let tmp: string | undefined;
  let captureTime: Date | null = null;
  let timeSource: TimeSource = 'none';

  try {
    tmp = await mkdtemp(path.join(tmpdir(), 'twenty4-validate-'));
    const ext = path.extname(row.storagePath) || '.bin';
    const local = path.join(tmp, `media${ext}`);
    // Cap the download at the §10 ceiling (defense-in-depth): a swapped oversize
    // object can't be fully pulled, even past the ETag check.
    await downloadObject(buckets.raw, row.storagePath, local, MAX_DOWNLOAD_BYTES);

    const isImage = (row.contentType ?? row.mediaType).startsWith('image')
      ? true
      : row.mediaType === 'photo';

    if (isImage) {
      captureTime = await exifCaptureInstant(local, deviceTz);
      if (captureTime) timeSource = 'exif';
    } else {
      captureTime = await videoCreationTime(local);
      if (captureTime) timeSource = 'video_creation_time';
    }
  } catch (err) {
    // Unexpected download/parse failure → mark invalid, never crash.
    await persist(mediaId, {
      validationStatus: 'invalid',
      processingStatus: 'failed',
      deviceTimeSuspicious,
      captureTimeUnverified: false,
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
      captureTimeUnverified: false,
      reason: 'processing_error',
    };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  /* ---- a RELIABLE embedded time exists → it MUST be in today's window ----- */
  if (captureTime) {
    const captureBucket = resolveDayBucket(
      captureTime,
      deviceTz,
      env.DAY_WINDOW_OFFSET_HOURS,
    );
    const inWindow = captureBucket === rowBucket;

    await persist(mediaId, {
      validationStatus: inWindow ? 'valid' : 'invalid',
      processingStatus: inWindow ? 'valid' : 'invalid',
      originalTimestamp: captureTime,
      deviceTimeSuspicious,
      captureTimeUnverified: false,
      metadata: {
        timeSource,
        capturedInApp: row.capturedInApp,
        captureBucket,
        rowBucket,
        inWindow,
        captureTimeUnverified: false,
        deviceTimeSuspicious,
      },
    });

    return {
      mediaId,
      validationStatus: inWindow ? 'valid' : 'invalid',
      timeSource,
      deviceTimeSuspicious,
      captureTimeUnverified: false,
      reason: inWindow ? undefined : 'out_of_window',
    };
  }

  /* ---- no embedded time: demote any client `original_timestamp` ----------- */
  // A client-passed original_timestamp can RAISE SUSPICION but NEVER make an item
  // valid on its own. If the client even claims an OLD time, that's a backdating
  // tell → invalidate outright (it contradicts the "captured today" requirement).
  if (row.originalTimestamp) {
    const claimedBucket = resolveDayBucket(
      row.originalTimestamp,
      deviceTz,
      env.DAY_WINDOW_OFFSET_HOURS,
    );
    if (claimedBucket !== rowBucket) {
      await persist(mediaId, {
        validationStatus: 'invalid',
        processingStatus: 'invalid',
        deviceTimeSuspicious,
        captureTimeUnverified: false,
        metadata: {
          timeSource: 'none',
          capturedInApp: row.capturedInApp,
          clientClaimedBucket: claimedBucket,
          rowBucket,
          reason: 'client_time_out_of_window',
          deviceTimeSuspicious,
        },
      });
      return {
        mediaId,
        validationStatus: 'invalid',
        timeSource: 'none',
        deviceTimeSuspicious,
        captureTimeUnverified: false,
        reason: 'out_of_window',
      };
    }
    // Client time is in-window: it's NOT proof of freshness (demoted), so it does
    // not by itself validate. Fall through to the in-app / reject branches below.
  }

  /* ---- no embedded time, not backdated → trust ONLY the in-app path ------- */
  if (row.capturedInApp) {
    // VALID on the fresh-upload floor + in-app capture, but freshness is ASSERTED,
    // not PROVEN — flag it loudly. (See SECURITY note: needs Phase-2 attestation.)
    await persist(mediaId, {
      validationStatus: 'valid',
      processingStatus: 'valid',
      originalTimestamp: row.originalTimestamp ?? serverReceiveTime,
      deviceTimeSuspicious,
      captureTimeUnverified: true,
      metadata: {
        timeSource: 'none',
        capturedInApp: true,
        captureTimeUnverified: true,
        rowBucket,
        deviceTimeSuspicious,
      },
    });
    return {
      mediaId,
      validationStatus: 'valid',
      timeSource: 'none',
      deviceTimeSuspicious,
      captureTimeUnverified: true,
      reason: 'capture_time_unverified',
    };
  }

  /* ---- gallery pick, no embedded time → cannot confirm freshness → INVALID  */
  // STRICTER defensible option (documented): a gallery file with no embedded
  // capture time cannot be confirmed fresh, so we reject rather than trust an
  // unverifiable upload.
  await persist(mediaId, {
    validationStatus: 'invalid',
    processingStatus: 'invalid',
    deviceTimeSuspicious,
    captureTimeUnverified: false,
    metadata: {
      timeSource: 'none',
      capturedInApp: false,
      rowBucket,
      reason: 'no_capture_time',
      deviceTimeSuspicious,
    },
  });
  return {
    mediaId,
    validationStatus: 'invalid',
    timeSource: 'none',
    deviceTimeSuspicious,
    captureTimeUnverified: false,
    reason: 'no_capture_time',
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
    captureTimeUnverified: boolean;
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
