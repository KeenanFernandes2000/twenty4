// validate-media processor (M4 §5) — the heart of the upload pipeline.
//
// Runs AFTER /complete has gated the object (size/type via HeadObject) and pinned
// the validated ETag. This job:
//   1. Re-HeadObjects the key and asserts the PINNED ETag still matches (else the
//      object was swapped after /complete → TOCTOU → mark invalid/tampered).
//   2. Resolves original_timestamp via the hierarchy:
//        EXIF DateTimeOriginal  →  device media-library ts (deviceCapturedAt)
//        →  file-creation ts (declaredOriginalTimestamp)  →  none ⇒ reject.
//   3. For video, probes duration; rejects if > 60s.
//   4. Checks the resolved timestamp falls inside the PERSISTED day_bucket window.
//   5. Computes the device-clock delta vs server time → anti-tamper flag (a flag,
//      not necessarily a rejection).
//   6. Carries the loud `freshnessNotProven` flag (A14).
//   7. Sets validation_status (valid|invalid) + the terminal processing_status.
//
// Exported as a plain async function so tests can run a job synchronously against
// the live stack (concurrency 1 → deterministic) AND the BullMQ worker can call it.
import { eq, sql } from "drizzle-orm";
import exifr from "exifr";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyMediaItem } from "@twenty4/contracts/db";
import {
  MAX_VIDEO_DURATION_MS,
  resolveDayBucket,
  DAY_BUCKET_ROLLOVER_HOUR,
  sniffContainer,
  sniffMatchesMediaType,
} from "@twenty4/contracts";
import type { WorkerDb } from "./db.ts";
import { getObjectBytes, headObject, putObject, thumbnailKey, type WorkerS3 } from "./s3.ts";
import { probeDurationMs } from "./probe.ts";
import { extractPosterJpeg } from "./ffmpeg.ts";

export interface ValidateMediaDeps {
  db: WorkerDb;
  s3: WorkerS3;
}

export interface ValidateMediaJobData {
  mediaId: string;
}

export interface ValidateMediaResult {
  mediaId: string;
  validationStatus: "valid" | "invalid";
  processingStatus: "valid" | "invalid" | "failed";
  reason?: string;
}

// How far the device clock may differ from server time before we flag it (ms).
const DEVICE_CLOCK_SKEW_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// Video poster (M7 §12) — BEST-EFFORT. After a video validates, extract a
// representative frame (~10% in) with ffmpeg from the already-downloaded bytes,
// upload it to the thumbnails bucket at thumbnailKey(userId,itemId), and return that
// key for thumbnail_path. ANY failure (no ffmpeg, extraction error, S3 error) returns
// null — the item stays valid and the client falls back to the play-tile. A poster
// failure must NEVER fail validation.
async function extractAndUploadPoster(
  s3: WorkerS3,
  userId: string,
  itemId: string,
  bytes: Buffer,
  durationMs: number | null,
): Promise<string | null> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "t4poster-"));
    const src = join(dir, "video");
    const out = join(dir, "poster.jpg");
    await writeFile(src, bytes);
    // ~10% in (a representative frame, not the often-black first frame); default 0.5s.
    const atSec = durationMs && durationMs > 0 ? (durationMs * 0.1) / 1000 : 0.5;
    const ok = await extractPosterJpeg(src, atSec, out);
    if (!ok) return null;
    const posterBytes = await readFile(out);
    const key = thumbnailKey(userId, itemId);
    await putObject(s3, s3.thumbnailsBucket, key, posterBytes, "image/jpeg");
    return key;
  } catch (err) {
    console.error(`[validate-media] poster extraction failed for ${itemId}:`, (err as Error).message);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

type TsSource = "exif" | "media-library" | "file-creation" | "none";

// Resolve the original timestamp via the M4 hierarchy. Returns the chosen instant
// and which tier it came from. EXIF is read from the object bytes.
async function resolveOriginalTimestamp(
  bytes: Buffer,
  meta: { deviceCapturedAt?: string; declaredOriginalTimestamp?: string },
): Promise<{ ts: Date | null; source: TsSource }> {
  // 1. EXIF DateTimeOriginal (photos). exifr returns a Date for DateTimeOriginal.
  try {
    const exif = await exifr.parse(bytes, { pick: ["DateTimeOriginal", "CreateDate"] });
    const exifTs = (exif?.DateTimeOriginal ?? exif?.CreateDate) as Date | undefined;
    if (exifTs instanceof Date && !Number.isNaN(exifTs.getTime())) {
      return { ts: exifTs, source: "exif" };
    }
  } catch {
    // Not an EXIF-bearing file (e.g. video / PNG) — fall through.
  }

  // 2. Device media-library timestamp.
  if (meta.deviceCapturedAt) {
    const d = new Date(meta.deviceCapturedAt);
    if (!Number.isNaN(d.getTime())) return { ts: d, source: "media-library" };
  }

  // 3. File-creation timestamp (client-declared).
  if (meta.declaredOriginalTimestamp) {
    const d = new Date(meta.declaredOriginalTimestamp);
    if (!Number.isNaN(d.getTime())) return { ts: d, source: "file-creation" };
  }

  // 4. None resolvable → reject.
  return { ts: null, source: "none" };
}

// The processor. Idempotent-ish: if the row is already terminal (valid/invalid),
// it recomputes and overwrites consistently (concurrency 1 keeps this safe).
//
// HIGH-4 — never wedge a row in `validating` forever. This wrapper catches ANY
// uncaught throw from the core logic (including a db.update write failure that
// bubbles past the inner try/catch blocks) and best-effort marks the row TERMINAL
// (`processing_status=failed`). So a job that exhausts BullMQ retries always leaves
// a terminal row — M4 never depends on the M9 reclaim sweep to avoid a permanent
// wedge. `optionalThrow` re-raises so BullMQ records the failure (and retries).
export async function processValidateMedia(
  deps: ValidateMediaDeps,
  data: ValidateMediaJobData,
): Promise<ValidateMediaResult> {
  try {
    return await runValidation(deps, data);
  } catch (err) {
    // Best-effort terminal marking. Keep validation_status=invalid so a tampered/
    // unverified item is never servable; mark processing_status=failed so the row
    // is terminal, not stuck `validating`.
    try {
      await deps.db.db
        .update(dailyMediaItem)
        .set({
          processingStatus: "failed",
          validationStatus: "invalid",
          metadataSummary: sql`COALESCE(${dailyMediaItem.metadataSummary}, '{}'::jsonb) || ${JSON.stringify(
            { processorError: (err as Error).message, freshnessNotProven: true },
          )}::jsonb`,
        })
        .where(eq(dailyMediaItem.id, data.mediaId));
    } catch {
      // If even the terminal write fails, swallow — re-raising the ORIGINAL error
      // is more useful for the retry/log path below.
    }
    // Re-raise so BullMQ records the job as failed and retries (attempts: 3).
    throw err;
  }
}

// The core validation logic (see processValidateMedia for the HIGH-4 wrapper).
async function runValidation(
  deps: ValidateMediaDeps,
  data: ValidateMediaJobData,
): Promise<ValidateMediaResult> {
  const { db, s3 } = deps;
  const { mediaId } = data;

  const rows = await db.db.select().from(dailyMediaItem).where(eq(dailyMediaItem.id, mediaId)).limit(1);
  const row = rows[0];
  if (!row) {
    return { mediaId, validationStatus: "invalid", processingStatus: "failed", reason: "row not found" };
  }

  // Mark validating (lifecycle).
  await db.db
    .update(dailyMediaItem)
    .set({ processingStatus: "validating" })
    .where(eq(dailyMediaItem.id, mediaId));

  const summary = (row.metadataSummary ?? {}) as Record<string, unknown>;
  const pinnedEtag = typeof summary.pinnedEtag === "string" ? summary.pinnedEtag : undefined;
  const deviceTimezone = typeof summary.deviceTimezone === "string" ? summary.deviceTimezone : "UTC";
  const deviceCapturedAt = typeof summary.deviceCapturedAt === "string" ? summary.deviceCapturedAt : undefined;
  const declaredOriginalTimestamp =
    typeof summary.declaredOriginalTimestamp === "string" ? summary.declaredOriginalTimestamp : undefined;

  // Helper to finalize a verdict.
  const finalize = async (
    verdict: "valid" | "invalid",
    extra: Record<string, unknown>,
    proc?: "valid" | "invalid" | "failed",
    originalTimestamp?: Date | null,
    durationMs?: number | null,
    thumbnailPath?: string | null,
  ): Promise<ValidateMediaResult> => {
    const newSummary = { ...summary, ...extra, freshnessNotProven: true };
    await db.db
      .update(dailyMediaItem)
      .set({
        validationStatus: verdict,
        processingStatus: proc ?? verdict,
        metadataSummary: newSummary,
        ...(originalTimestamp !== undefined ? { originalTimestamp } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(thumbnailPath !== undefined ? { thumbnailPath } : {}),
      })
      .where(eq(dailyMediaItem.id, mediaId));
    return {
      mediaId,
      validationStatus: verdict,
      processingStatus: proc ?? verdict,
      reason: typeof extra.reason === "string" ? extra.reason : undefined,
    };
  };

  let head;
  try {
    head = await headObject(s3, row.storagePath);
  } catch (err) {
    // Infra error talking to S3 → failed (distinct from a verdict).
    return finalize("invalid", { reason: `headobject error: ${(err as Error).message}` }, "failed");
  }

  // 1. Object gone → invalid.
  if (!head) {
    return finalize("invalid", { reason: "object missing at validation" }, "invalid");
  }

  // 1b. ETag-pin TOCTOU: a swapped re-PUT changes the ETag. Reject as tampered.
  if (pinnedEtag && head.etag && head.etag !== pinnedEtag) {
    return finalize(
      "invalid",
      { reason: "etag mismatch — object swapped after complete", tampered: true, observedEtag: head.etag },
      "invalid",
    );
  }

  // Pull bytes for EXIF/probe.
  let bytes: Buffer;
  try {
    bytes = await getObjectBytes(s3, row.storagePath);
  } catch (err) {
    return finalize("invalid", { reason: `getobject error: ${(err as Error).message}` }, "failed");
  }

  // 1c. CRITICAL-1 — sniff the REAL container from the header bytes and assert it
  //     matches the declared mediaType BEFORE anything else certifies the item.
  //     We do NOT trust the client/HeadObject content-type for the verdict. A
  //     non-image (ELF/random) declared as a photo, or a video mislabeled as a
  //     photo, is rejected here and never falls through to the timestamp tiers.
  const container = sniffContainer(bytes);
  if (!sniffMatchesMediaType(row.mediaType, container)) {
    return finalize(
      "invalid",
      {
        reason: `magic-byte mismatch: sniffed ${container} does not match mediaType ${row.mediaType}`,
        sniffedContainer: container,
        sniffMismatch: true,
      },
      "invalid",
    );
  }

  // 2. Resolve the original timestamp via the hierarchy.
  const { ts, source } = await resolveOriginalTimestamp(bytes, { deviceCapturedAt, declaredOriginalTimestamp });
  if (!ts) {
    return finalize(
      "invalid",
      { reason: "no resolvable original timestamp", timestampSource: "none" },
      "invalid",
    );
  }

  // 3. Video duration probe.
  let durationMs: number | null = row.durationMs ?? null;
  if (row.mediaType === "video") {
    try {
      durationMs = await probeDurationMs(bytes);
    } catch (err) {
      return finalize("invalid", { reason: `duration probe error: ${(err as Error).message}` }, "failed");
    }
    if (durationMs === null) {
      return finalize("invalid", { reason: "could not probe video duration" }, "invalid", ts, null);
    }
    if (durationMs > MAX_VIDEO_DURATION_MS) {
      return finalize(
        "invalid",
        { reason: `video too long: ${durationMs}ms > ${MAX_VIDEO_DURATION_MS}ms`, timestampSource: source },
        "invalid",
        ts,
        durationMs,
      );
    }
  }

  // 4. Resolved timestamp must fall in the PERSISTED day_bucket window.
  const resolvedBucket = resolveDayBucket(ts, deviceTimezone);
  // row.dayBucket is a YYYY-MM-DD string (drizzle `date`).
  const persistedBucket = String(row.dayBucket);
  if (resolvedBucket !== persistedBucket) {
    return finalize(
      "invalid",
      {
        reason: `timestamp outside day_bucket: resolved ${resolvedBucket} != persisted ${persistedBucket}`,
        timestampSource: source,
        resolvedBucket,
      },
      "invalid",
      ts,
      durationMs,
    );
  }

  // 5. Anti-tamper device-clock delta. Compare the device-reported capture time
  //    (media-library) against server-now ONLY as a coarse skew signal; a large
  //    delta sets a flag but does NOT by itself reject (A14 — freshness forgeable).
  const serverNow = Date.now();
  let deviceClockDeltaMs: number | null = null;
  if (deviceCapturedAt) {
    deviceClockDeltaMs = Math.abs(serverNow - new Date(deviceCapturedAt).getTime());
  }
  const deviceClockSkewFlag =
    deviceClockDeltaMs !== null && deviceClockDeltaMs > DEVICE_CLOCK_SKEW_THRESHOLD_MS;

  // Video poster (M7 §12) — best-effort, only for videos; photos keep thumbnail_path
  // null (client renders from downloadUrl). Failure never blocks the valid verdict.
  let thumbnailPath: string | null | undefined = undefined;
  if (row.mediaType === "video") {
    thumbnailPath = await extractAndUploadPoster(s3, row.userId, mediaId, bytes, durationMs);
  }

  // Accept.
  return finalize(
    "valid",
    {
      reason: "ok",
      timestampSource: source,
      resolvedBucket,
      deviceClockDeltaMs,
      deviceClockSkewFlag,
      rolloverHour: DAY_BUCKET_ROLLOVER_HOUR,
    },
    "valid",
    ts,
    durationMs,
    thumbnailPath,
  );
}
