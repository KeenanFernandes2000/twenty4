// Media routes (M4 §5). All require a valid session (requireSession). Owner-only
// routes (complete/download-url/delete) load the row and 404 if it isn't the
// caller's — a non-owner gets MEDIA_NOT_FOUND (404), not a leak that it exists.
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Queue } from "bullmq";
import {
  DailyLimitReachedError,
  MediaNotFoundError,
  MediaTooLargeError,
  MediaTypeNotAllowedError,
  downloadUrlResSchema,
  isAllowedMime,
  isValidTimezone,
  mediaInitReqSchema,
  resolveDayBucket,
  type DownloadUrlRes,
  type MediaInitRes,
  type MediaItemDTO,
  type MediaTodayRes,
} from "@twenty4/contracts";
import { dailyMediaItem, user } from "@twenty4/contracts/db";
import {
  deleteObject,
  headObject,
  presignGet,
  presignPut,
  rawKey,
  type S3Deps,
} from "./s3.ts";
import { enqueueValidateMedia, type ValidateMediaJobData } from "./queue.ts";
import type { DbClient } from "../db.ts";
import type { makeRequireSession } from "../auth/guards.ts";

export interface MediaRoutesDeps {
  db: DbClient;
  requireSession: ReturnType<typeof makeRequireSession>;
  s3: S3Deps;
  queue: Queue<ValidateMediaJobData>;
  rawTtlHours: number;
  // Env-overridable caps (default to the contracts constants). Tests inject small
  // values to exercise the over-cap reject paths deterministically.
  maxBytes: number;
  maxItemsPerDay: number;
}

type MediaRow = typeof dailyMediaItem.$inferSelect;

// Load a row and assert the caller owns it. Throws MEDIA_NOT_FOUND otherwise
// (owner-only routes must not leak existence to non-owners).
async function loadOwnedRow(db: DbClient, id: string, userId: string): Promise<MediaRow> {
  const rows = await db.db.select().from(dailyMediaItem).where(eq(dailyMediaItem.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.userId !== userId) throw new MediaNotFoundError();
  return row;
}

// Build the wire DTO, including a signed download URL for uploaded items.
async function toItemDto(s3: S3Deps, row: MediaRow): Promise<MediaItemDTO> {
  // Only items that have actually been PUT (past `uploaded`) get a download URL.
  const hasObject = row.processingStatus !== "uploaded" && row.processingStatus !== "deleted";
  const downloadUrl = hasObject ? await presignGet(s3, row.storagePath) : null;
  return {
    id: row.id,
    mediaType: row.mediaType,
    dayBucket: String(row.dayBucket),
    validationStatus: row.validationStatus,
    processingStatus: row.processingStatus,
    originalTimestamp: row.originalTimestamp ? row.originalTimestamp.toISOString() : null,
    durationMs: row.durationMs ?? null,
    uploadTimestamp: row.uploadTimestamp.toISOString(),
    downloadUrl,
    metadataSummary: (row.metadataSummary ?? {}) as Record<string, unknown>,
  };
}

export async function registerMediaRoutes(app: FastifyInstance, deps: MediaRoutesDeps): Promise<void> {
  const { db, requireSession, s3, queue, rawTtlHours, maxBytes, maxItemsPerDay } = deps;

  // ── POST /media (init) ──────────────────────────────────────────────────────
  // Create the row, persist day_bucket + expiry_at, enforce ≤50/day + MIME
  // allowlist (early reject), return a presigned PUT (host = public endpoint).
  app.post("/media", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = mediaInitReqSchema.parse(req.body);
    const u = req.user!;

    // Early MIME allowlist check (declared content-type) → 415.
    if (!isAllowedMime(body.mediaType, body.contentType)) {
      throw new MediaTypeNotAllowedError(`Content-type ${body.contentType} not allowed for ${body.mediaType}`);
    }

    // deviceTimezone is already validated as a real IANA zone by the DTO refine.
    const expiryAt = new Date(Date.now() + rawTtlHours * 60 * 60 * 1000);

    // ── CRITICAL-2 + HIGH-3 ──────────────────────────────────────────────────
    // The cap-check + insert run in ONE transaction guarded by a PG transaction-
    // scoped advisory lock keyed on (user, canonical_day_bucket). The lock
    // serializes concurrent inits for the same user/day so the count-then-insert
    // is race-free (TOCTOU closed). The day_bucket is resolved from a SERVER-
    // anchored canonical tz (user.timezone), NOT the raw per-request
    // deviceTimezone — so rotating zones cannot mint fresh 50-item buckets.
    const inserted = await db.db.transaction(async (tx) => {
      // Resolve the canonical tz: persisted user.timezone, else adopt this
      // request's (validated) deviceTimezone as the canonical one (first init).
      const urows = await tx
        .select({ timezone: user.timezone })
        .from(user)
        .where(eq(user.id, u.id))
        .limit(1);
      let canonicalTz = urows[0]?.timezone ?? null;
      if (!canonicalTz || !isValidTimezone(canonicalTz)) {
        canonicalTz = body.deviceTimezone;
        await tx.update(user).set({ timezone: canonicalTz }).where(eq(user.id, u.id));
      }

      // The day_bucket for BOTH the cap count AND the persisted row uses the
      // canonical tz. The request's deviceTimezone is recorded but never buckets.
      const dayBucket = resolveDayBucket(new Date(), canonicalTz);
      const timezoneDriftFlag = body.deviceTimezone !== canonicalTz;

      // Serialize concurrent inits for THIS (user, day) — transaction-scoped
      // advisory lock (auto-released at commit/rollback). Mirrors the M3 join's
      // FOR UPDATE serialization, but keyed on a synthetic (user:day) string.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${u.id}::text || ':' || ${dayBucket}::text, 0))`,
      );

      // Now the count is accurate under the lock.
      const cnt = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(dailyMediaItem)
        .where(
          and(
            eq(dailyMediaItem.userId, u.id),
            eq(dailyMediaItem.dayBucket, dayBucket),
            sql`${dailyMediaItem.processingStatus} <> 'deleted'`,
          ),
        );
      const existing = cnt[0]?.n ?? 0;
      if (existing >= maxItemsPerDay) {
        throw new DailyLimitReachedError(`Daily limit of ${maxItemsPerDay} items reached`);
      }

      const rows = await tx
        .insert(dailyMediaItem)
        .values({
          userId: u.id,
          dayBucket,
          mediaType: body.mediaType,
          storagePath: "", // set below once we know the key
          byteSize: body.byteSize,
          processingStatus: "uploaded",
          validationStatus: "pending",
          expiryAt,
          metadataSummary: {
            deviceTimezone: body.deviceTimezone,
            canonicalTimezone: canonicalTz,
            ...(timezoneDriftFlag
              ? { timezoneDriftFlag: { request: body.deviceTimezone, canonical: canonicalTz } }
              : {}),
            deviceCapturedAt: body.deviceCapturedAt ?? null,
            declaredOriginalTimestamp: body.declaredOriginalTimestamp ?? null,
            declaredContentType: body.contentType,
            declaredByteSize: body.byteSize,
          },
        })
        .returning();
      return rows[0]!;
    });

    const row = inserted;
    const key = rawKey(u.id, row.id);
    await db.db.update(dailyMediaItem).set({ storagePath: key }).where(eq(dailyMediaItem.id, row.id));

    const uploadUrl = await presignPut(s3, key, body.contentType);
    const res: MediaInitRes = { id: row.id, uploadUrl, storageKey: key };
    reply.status(201).send(res);
  });

  // ── POST /media/:id/complete ────────────────────────────────────────────────
  // Owner-only. HeadObject gate (size/type), reject+delete on violation, pin the
  // validated ETag (TOCTOU), enqueue validate-media. Idempotent.
  app.post(
    "/media/:id/complete",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      const row = await loadOwnedRow(db, id, u.id);

      // Idempotent: a 2nd complete on an already-advanced row is a no-op success
      // (no double-enqueue, no re-charge). `uploaded` is the only state we act on.
      if (row.processingStatus !== "uploaded") {
        reply.status(200).send(await toItemDto(s3, row));
        return;
      }

      // HeadObject (internal endpoint) → actual size/type/etag.
      const head = await headObject(s3, row.storagePath);
      if (!head) {
        // Nothing was uploaded → reject (no object to delete).
        await db.db
          .update(dailyMediaItem)
          .set({
            processingStatus: "invalid",
            validationStatus: "invalid",
            metadataSummary: { ...(row.metadataSummary as object), completeReason: "object missing" },
          })
          .where(eq(dailyMediaItem.id, id));
        throw new MediaNotFoundError("No uploaded object found for this item");
      }

      const summary = (row.metadataSummary ?? {}) as Record<string, unknown>;
      const declaredContentType =
        typeof summary.declaredContentType === "string" ? summary.declaredContentType : "";

      // Gate: size cap.
      const rejectAndDelete = async (reason: string, throwErr: () => never): Promise<never> => {
        await deleteObject(s3, row.storagePath);
        await db.db
          .update(dailyMediaItem)
          .set({
            processingStatus: "invalid",
            validationStatus: "invalid",
            metadataSummary: { ...summary, completeReason: reason, actualContentLength: head.contentLength },
          })
          .where(eq(dailyMediaItem.id, id));
        throwErr();
      };

      if (head.contentLength > maxBytes) {
        await rejectAndDelete(`too large: ${head.contentLength} > ${maxBytes}`, () => {
          throw new MediaTooLargeError(`Object is ${head.contentLength} bytes; max ${maxBytes}`);
        });
      }

      // Gate: actual content-type in allowlist for the declared media type.
      const actualType = head.contentType ?? "";
      if (!isAllowedMime(row.mediaType, actualType)) {
        await rejectAndDelete(`type not allowed: ${actualType}`, () => {
          throw new MediaTypeNotAllowedError(`Uploaded content-type ${actualType} not allowed`);
        });
      }

      // Gate: actual type must not contradict the declared type (e.g. declared
      // image/jpeg but actually video/mp4). Both must be in the same media class.
      if (declaredContentType && !isAllowedMime(row.mediaType, declaredContentType)) {
        await rejectAndDelete(`declared type mismatch: ${declaredContentType}`, () => {
          throw new MediaTypeNotAllowedError(`Declared content-type ${declaredContentType} mismatches`);
        });
      }

      // MEDIUM-5: actual-vs-declared base content-type EQUALITY. Even if both are
      // in the allowlist, a stored type that differs from the declared one (e.g.
      // declared image/png but stored image/jpeg) is a mismatch → reject + delete.
      // Consistent with the worker byte-sniff verdict (the bytes must be what the
      // client said they were).
      const baseOf = (ct: string): string => ct.split(";")[0]!.trim().toLowerCase();
      if (declaredContentType && baseOf(actualType) !== baseOf(declaredContentType)) {
        await rejectAndDelete(
          `actual vs declared type mismatch: stored ${actualType} != declared ${declaredContentType}`,
          () => {
            throw new MediaTypeNotAllowedError(
              `Stored content-type ${actualType} does not match declared ${declaredContentType}`,
            );
          },
        );
      }

      // Pass: pin the validated ETag (close the swapped-object TOCTOU) and advance
      // to `validating`, then enqueue. The pinned ETag lives in metadata_summary.
      const nextSummary = {
        ...summary,
        pinnedEtag: head.etag ?? null,
        actualContentType: actualType,
        actualContentLength: head.contentLength,
      };
      await db.db
        .update(dailyMediaItem)
        .set({ processingStatus: "validating", metadataSummary: nextSummary })
        .where(eq(dailyMediaItem.id, id));

      // Enqueue (idempotent jobId). If the enqueue throws (Redis blip), the row is
      // already `validating` and a later /complete is a no-op — so re-enqueue won't
      // happen automatically; that's acceptable (the row can be re-driven manually).
      await enqueueValidateMedia(queue, id);

      const fresh = await loadOwnedRow(db, id, u.id);
      reply.status(200).send(await toItemDto(s3, fresh));
    },
  );

  // ── GET /media/today ────────────────────────────────────────────────────────
  // Caller's items for the CURRENT persisted day_bucket. HIGH-3: "today" resolves
  // from the SERVER-anchored canonical tz (user.timezone), NOT a client-supplied
  // `tz` query param — so a client cannot select a different bucket than the one
  // their inits write to. Any client `tz` is ignored. Falls back to UTC if the
  // user has no canonical tz yet (no media init has happened).
  app.get("/media/today", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const u = req.user!;
    const urows = await db.db.select({ timezone: user.timezone }).from(user).where(eq(user.id, u.id)).limit(1);
    const canonicalTz = urows[0]?.timezone ?? null;
    const tz = canonicalTz && isValidTimezone(canonicalTz) ? canonicalTz : "UTC";
    const dayBucket = resolveDayBucket(new Date(), tz);

    const rows = await db.db
      .select()
      .from(dailyMediaItem)
      .where(and(eq(dailyMediaItem.userId, u.id), eq(dailyMediaItem.dayBucket, dayBucket)));

    const items: MediaItemDTO[] = [];
    for (const r of rows) items.push(await toItemDto(s3, r));
    const res: MediaTodayRes = { dayBucket, items };
    reply.status(200).send(res);
  });

  // ── GET /media/:id/download-url ─────────────────────────────────────────────
  // Owner-only short-TTL signed GET (host = public endpoint).
  app.get(
    "/media/:id/download-url",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      const row = await loadOwnedRow(db, id, u.id);

      // MEDIUM-6: never presign a GET for a row that was rejected/likely tampered.
      // Require the validation verdict to be `valid` AND the lifecycle to not be in
      // a terminal-bad state. This pre-empts the M8 feed surface from serving
      // invalid/failed/deleted content. Non-valid → 404 (no existence-of-content
      // leak, consistent with owner-only 404s).
      const badProcessing = row.processingStatus === "invalid" || row.processingStatus === "failed" ||
        row.processingStatus === "deleted";
      if (row.validationStatus !== "valid" || badProcessing) {
        throw new MediaNotFoundError("Media item is not available for download");
      }

      const downloadUrl = await presignGet(s3, row.storagePath);
      const res: DownloadUrlRes = {
        id: row.id,
        downloadUrl,
        expiresInSec: s3.downloadTtlSec,
      };
      reply.status(200).send(downloadUrlResSchema.parse(res));
    },
  );

  // ── DELETE /media/:id ───────────────────────────────────────────────────────
  // Owner-only hard-delete. LOW-7: delete the ROW first, THEN best-effort delete
  // the S3 object. A partial failure (S3 delete throws) leaves a deletable ORPHAN
  // object (swept by M9), never a row pointing at a missing object. The S3 failure
  // must NOT resurrect the row, so we swallow it (the row is already gone).
  app.delete("/media/:id", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const u = req.user!;
    const row = await loadOwnedRow(db, id, u.id);
    await db.db.delete(dailyMediaItem).where(eq(dailyMediaItem.id, id));
    try {
      await deleteObject(s3, row.storagePath);
    } catch {
      // Object delete failed → leave the orphan for the M9 sweep. The row is gone.
    }
    reply.status(200).send({ status: "deleted" });
  });
}
