/**
 * media module (§8 Media bucket) — Slice 2: capture/upload via signed URLs, the
 * 4am day-window, and the validation hierarchy hand-off.
 *
 * Routes (all require a valid, active session via `requireSession`):
 *
 *   POST   /media                  upload INIT — server resolves day_bucket
 *                                   authoritatively, inserts a `pending` row,
 *                                   returns a presigned PUT (raw bucket) + the id.
 *   POST   /media/:id/complete      mark uploaded → enqueue `validate-media`.
 *   GET    /media/today             caller's items for TODAY's bucket (Today screen).
 *   GET    /media/:id/download-url  OWNER-ONLY presigned GET (TTL ≤ remaining life).
 *   DELETE /media/:id               owner removes → hard-delete row + S3 object.
 *
 * Security invariants:
 *   - `day_bucket` is resolved server-side from the device tz (§6 Q3); a client
 *     CANNOT influence which bucket a row lands in beyond supplying its tz.
 *   - the raw object key is server-minted & namespaced to the caller's userId, so
 *     a client can't presign into another user's namespace.
 *   - download-url is owner-only; a non-owner (or expired/deleted) item → 404 with
 *     NO existence leak (§11, Q7).
 *   - presigned PUT/GET TTLs are clamped to the content's remaining lifetime.
 */
import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { dailyMediaItems, type DailyMediaItem } from '@twenty4/contracts/db';
import {
  mediaInitRequestSchema,
  mediaInitResponseSchema,
  mediaItemResponseSchema,
  mediaDownloadUrlResponseSchema,
  todayMediaResponseSchema,
  MAX_DAILY_ITEMS,
  MAX_ITEM_BYTES,
  MAX_VIDEO_MS,
  type MediaItemResponse,
} from '@twenty4/contracts/dto';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import { errors } from '@twenty4/contracts/errors';

import { requireSession } from '../../auth/middleware.js';
import { db } from '../../db/index.js';
import { env } from '../../env.js';
import { throttleMediaInit } from '../../lib/rateLimit.js';
import {
  buckets,
  deleteObject,
  objectHead,
  presignGet,
  presignPut,
  rawObjectKey,
} from '../../storage/s3.js';
import {
  enqueueValidateMedia,
  type ValidateMediaJob,
} from '../../queue/producers.js';

/** Raw items get a generous lifetime upper bound (the real purge is Slice 7).
 * For the presign TTL clamp we treat "remaining lifetime" as ~25h from now when
 * `expiry_at` is not yet set, matching the montage safety TTL ceiling (§6). */
const RAW_LIFETIME_HOURS = 25;

/** Default day bucket tz when a client omits it: UTC (server-authoritative). */
const DEFAULT_TZ = 'UTC';

/**
 * Post-upload size cap (§10, ≤200MB/item). A presigned PUT can't enforce size
 * up-front, so POST /media/:id/complete HeadObjects the landed object and rejects
 * (+ deletes it) if it's over this cap or the content-type doesn't match. The
 * effective cap is `min(env override, §10 hard limit)` so the env can only ever
 * TIGHTEN the limit, never loosen it past the §10 ceiling.
 */
const MAX_UPLOAD_BYTES = Math.min(env.MAX_UPLOAD_BYTES, MAX_ITEM_BYTES);

/** Project a row into the owner-facing DTO (optionally with a preview URL). */
function toItemResponse(
  row: DailyMediaItem,
  previewUrl?: string | null,
): MediaItemResponse {
  return mediaItemResponseSchema.parse({
    id: row.id,
    mediaType: row.mediaType,
    dayBucket: row.dayBucket,
    validationStatus: row.validationStatus,
    processingStatus: row.processingStatus,
    capturedInApp: row.capturedInApp,
    deviceTimeSuspicious: row.deviceTimeSuspicious,
    durationMs: row.durationMs ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    previewUrl: previewUrl ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Remaining-lifetime expiry for a raw row (for the presign TTL clamp). */
function rawExpiry(row: Pick<DailyMediaItem, 'expiryAt' | 'createdAt'>): Date {
  if (row.expiryAt) return row.expiryAt;
  return new Date(row.createdAt.getTime() + RAW_LIFETIME_HOURS * 3600 * 1000);
}

export const mediaModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireSession);

  /* ------------------------------ POST /media ------------------------------ */
  // Upload INIT. Validates the request, enforces the §10 per-day item cap and
  // video-duration cap, resolves the day bucket authoritatively, inserts a
  // `pending`/`uploaded` row with a server-minted key, and returns a presigned PUT.
  app.post('/', async (req, reply) => {
    const me = req.user!;
    const body = mediaInitRequestSchema.parse(req.body);

    await throttleMediaInit({ userId: me.id });

    // §10: videos must be ≤ 60s (also re-checked by the worker via ffprobe).
    if (body.mediaType === 'video' && body.durationMs && body.durationMs > MAX_VIDEO_MS) {
      throw errors.payloadTooLarge('video exceeds the 60s limit', {
        maxVideoMs: MAX_VIDEO_MS,
      });
    }

    // Anti-tamper: a non-capture (gallery) upload MUST carry a device_timestamp so
    // the worker can compute the device-clock-vs-server delta. Making it optional
    // let a client trivially disable the anti-tamper check by omitting it; require
    // it here (in-app captures are exempt — the trusted camera path supplies it).
    if (!body.capturedInApp && !body.deviceTimestamp) {
      throw errors.validation('device_timestamp is required for gallery uploads', {
        field: 'deviceTimestamp',
      });
    }

    // Resolve the authoritative 4am day bucket from the device tz at THIS instant.
    const deviceTz = body.deviceTimezone ?? DEFAULT_TZ;
    let dayBucket: string;
    try {
      dayBucket = resolveDayBucket(new Date(), deviceTz, env.DAY_WINDOW_OFFSET_HOURS);
    } catch {
      throw errors.validation('invalid device timezone', { deviceTimezone: deviceTz });
    }

    // §10: cap at 50 items per (user, day_bucket). Count NON-deleted rows.
    const countRows = (await db.execute(sql`
      select count(*)::int as n
      from daily_media_item
      where user_id = ${me.id}
        and day_bucket = ${dayBucket}
        and processing_status <> 'deleted'
    `)) as unknown as Array<{ n: number }>;
    if ((countRows[0]?.n ?? 0) >= MAX_DAILY_ITEMS) {
      throw errors.conflict('daily item limit reached', { max: MAX_DAILY_ITEMS });
    }

    const storageKey = rawObjectKey({
      userId: me.id,
      dayBucket,
      contentType: body.contentType,
    });

    const [row] = await db
      .insert(dailyMediaItems)
      .values({
        userId: me.id,
        dayBucket,
        mediaType: body.mediaType,
        contentType: body.contentType,
        storagePath: storageKey,
        capturedInApp: body.capturedInApp,
        deviceTimezone: deviceTz,
        deviceTimestamp: body.deviceTimestamp ? new Date(body.deviceTimestamp) : null,
        originalTimestamp: body.originalTimestamp
          ? new Date(body.originalTimestamp)
          : null,
        sizeBytes: body.sizeBytes,
        durationMs: body.durationMs ?? null,
        width: body.width ?? null,
        height: body.height ?? null,
        validationStatus: 'pending',
        // not yet uploaded; 'uploaded' is set on /complete. We start at 'uploaded'
        // default in the schema but override to a clearer "pending upload" state by
        // reusing 'uploaded' only once the PUT lands. Keep schema default ('uploaded')
        // to avoid an enum addition; the row is meaningless until /complete anyway.
        processingStatus: 'uploaded',
        expiryAt: new Date(Date.now() + RAW_LIFETIME_HOURS * 3600 * 1000),
      })
      .returning();
    if (!row) throw errors.internal('failed to create media item');

    const { url, expiresIn } = await presignPut(buckets.raw, storageKey, {
      expiryAt: rawExpiry(row),
    });

    reply.code(201);
    return mediaInitResponseSchema.parse({
      id: row.id,
      uploadUrl: url,
      storageKey,
      dayBucket,
      expiresIn,
    });
  });

  /* ------------------------- POST /media/:id/complete ---------------------- */
  // Mark the item uploaded and enqueue the §6 validate-media job. Owner-only.
  //
  // IDEMPOTENT (replay-safe): /complete only drives the row from the post-upload
  // 'uploaded' state to 'validating' ONCE, and enqueues exactly one validate-media
  // job. A REPLAY (the row already left 'uploaded') is a no-op that returns the
  // current row state with 200 — never a second enqueue. The single-claim race is
  // closed by a CONDITIONAL update (uploaded → validating) gated on the current
  // status; only the caller whose UPDATE returns a row enqueues.
  app.post('/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;

    const row = await loadOwnedOr404(id, me.id);

    // Replay guard: only a row still in the post-upload 'uploaded' state is eligible
    // to be completed. If it has already moved on (validating / valid / invalid /
    // failed / deleted), this is a duplicate /complete — return the current state
    // idempotently (200) WITHOUT re-Heading, re-gating, or re-enqueueing.
    if (row.processingStatus !== 'uploaded') {
      reply.code(200);
      return toItemResponse(row);
    }

    // Post-upload gate: HeadObject the landed raw object. A presigned PUT can't
    // enforce size/content-type up-front, so we verify here. On a violation we
    // DELETE the object and mark the row failed (§10 size/type caps).
    const head = await objectHead(buckets.raw, row.storagePath);
    if (!head) {
      // The PUT never landed — nothing to validate. (Object absent.)
      await db
        .update(dailyMediaItems)
        .set({ processingStatus: 'failed', validationStatus: 'invalid' })
        .where(eq(dailyMediaItems.id, row.id));
      throw errors.validation('upload not found; PUT the object before completing', {
        field: 'storageKey',
      });
    }

    const overCap =
      head.sizeBytes !== null && head.sizeBytes > MAX_UPLOAD_BYTES;
    // Content-type mismatch: what actually landed vs what was declared at init.
    // MinIO/S3 records the PUT's Content-Type; if the client lied (or PUT a
    // different type), reject. (Null/absent recorded type is tolerated — some S3
    // setups omit it — but a present mismatch is rejected.)
    const typeMismatch =
      !!head.contentType &&
      !!row.contentType &&
      head.contentType.split(';')[0]!.trim().toLowerCase() !==
        row.contentType.toLowerCase();

    if (overCap || typeMismatch) {
      await deleteObject(buckets.raw, row.storagePath);
      await db
        .update(dailyMediaItems)
        .set({ processingStatus: 'failed', validationStatus: 'invalid' })
        .where(eq(dailyMediaItems.id, row.id));
      throw errors.payloadTooLarge(
        overCap ? 'upload exceeds the size limit' : 'upload content-type mismatch',
        {
          maxBytes: MAX_UPLOAD_BYTES,
          ...(head.sizeBytes !== null ? { sizeBytes: head.sizeBytes } : {}),
          ...(typeMismatch
            ? { declared: row.contentType, actual: head.contentType }
            : {}),
        },
      );
    }

    // TOCTOU pin: persist the ETag + verified size of the EXACT object that passed
    // the gate. The worker re-Heads before downloading and refuses to process if the
    // ETag differs (a client re-PUT a swapped object to the same key, since the
    // presigned PUT stays reusable until its TTL). Set ATOMICALLY with the
    // uploaded → validating transition; the `processing_status = 'uploaded'`
    // predicate means only ONE concurrent /complete wins the claim (single enqueue).
    const [updated] = await db
      .update(dailyMediaItems)
      .set({
        processingStatus: 'validating',
        objectEtag: head.etag,
        objectSize: head.sizeBytes,
      })
      .where(
        and(
          eq(dailyMediaItems.id, row.id),
          eq(dailyMediaItems.processingStatus, 'uploaded'),
        ),
      )
      .returning();

    // Lost the race: a concurrent /complete already claimed the transition (and
    // enqueued). Return the current row idempotently — do NOT enqueue a second job.
    if (!updated) {
      const current = await loadOwnedOr404(id, me.id);
      reply.code(200);
      return toItemResponse(current);
    }

    const job: ValidateMediaJob = {
      mediaId: row.id,
      serverReceiveTime: new Date().toISOString(),
    };
    await enqueueValidateMedia(job);

    reply.code(202);
    return toItemResponse(updated);
  });

  /* ------------------------------ GET /media/today ------------------------- */
  // The caller's items for TODAY's bucket. Bucket resolved from the device tz
  // (query/header) or UTC; this is a READ so it does not persist anything.
  app.get('/today', async (req, reply) => {
    const me = req.user!;
    const q = req.query as { tz?: string };
    const deviceTz = q.tz ?? DEFAULT_TZ;
    let dayBucket: string;
    try {
      dayBucket = resolveDayBucket(new Date(), deviceTz, env.DAY_WINDOW_OFFSET_HOURS);
    } catch {
      throw errors.validation('invalid timezone', { tz: deviceTz });
    }

    const rows = await db
      .select()
      .from(dailyMediaItems)
      .where(
        and(
          eq(dailyMediaItems.userId, me.id),
          eq(dailyMediaItems.dayBucket, dayBucket),
        ),
      )
      .orderBy(dailyMediaItems.createdAt);

    const visible = rows.filter((r) => r.processingStatus !== 'deleted');

    const items = await Promise.all(
      visible.map(async (r) => {
        // Only presign a preview for items that have actually been uploaded +
        // aren't invalid/deleted. (Cheap: presign is local signing, no network.)
        let previewUrl: string | null = null;
        if (r.processingStatus !== 'uploaded' || r.validationStatus !== 'pending') {
          const signed = await presignGet(buckets.raw, r.storagePath, {
            expiryAt: rawExpiry(r),
          });
          previewUrl = signed.url;
        }
        return toItemResponse(r, previewUrl);
      }),
    );

    const validCount = visible.filter((r) => r.validationStatus === 'valid').length;

    reply.code(200);
    return todayMediaResponseSchema.parse({ dayBucket, items, validCount });
  });

  /* ----------------------- GET /media/:id/download-url --------------------- */
  // OWNER-ONLY presigned GET. A non-owner or missing/deleted item → 404 (no
  // existence leak, Q7). TTL clamped to the content's remaining lifetime so a
  // leaked URL 404s once the content is purged (§6/§11).
  app.get('/:id/download-url', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;

    const row = await loadOwnedOr404(id, me.id);
    if (row.processingStatus === 'deleted') {
      throw errors.notFound('media not found');
    }

    const { url, expiresIn } = await presignGet(buckets.raw, row.storagePath, {
      expiryAt: rawExpiry(row),
    });

    reply.code(200);
    return mediaDownloadUrlResponseSchema.parse({ url, expiresIn });
  });

  /* ----------------------------- DELETE /media/:id ------------------------- */
  // Owner removes an item → hard-delete the row AND the S3 object (§6 "user removes
  // item → hard-delete row + S3 object immediately"). Deleting the bytes is what
  // makes a previously-issued presigned GET 404 with the CONTENT, not just hide the
  // row — a leaked GET must not outlive the delete. We remove the object FIRST
  // (best-effort; DELETE is idempotent on S3) then drop the row.
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const row = await loadOwnedOr404(id, me.id);
    await deleteObject(buckets.raw, row.storagePath);
    await db.delete(dailyMediaItems).where(eq(dailyMediaItems.id, row.id));
    reply.code(204).send();
  });
};

/**
 * Load a media row that the caller OWNS, or throw 404. Used by complete /
 * download-url / delete. A non-owner gets the SAME 404 as a missing row (no
 * existence leak, Q7) — we never reveal that the id exists for another user.
 */
async function loadOwnedOr404(id: string, userId: string): Promise<DailyMediaItem> {
  if (!isUuid(id)) throw errors.notFound('media not found');
  const [row] = await db
    .select()
    .from(dailyMediaItems)
    .where(and(eq(dailyMediaItems.id, id), eq(dailyMediaItems.userId, userId)))
    .limit(1);
  if (!row) throw errors.notFound('media not found');
  return row;
}

/** Cheap uuid shape guard so a malformed :id 404s instead of erroring on the cast. */
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
