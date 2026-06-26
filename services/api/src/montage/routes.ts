// Montage routes (M7 §5). All require a valid session (requireSession). Owner-only
// routes load the row and 404 (MONTAGE_NOT_FOUND) if it isn't the caller's — a
// non-owner gets the SAME 404 as a missing montage (no existence leak, mirroring
// media's loadOwnedRow). The render itself runs in the worker; the API only
// resolves the day's valid media, owns the status machine, and enqueues.
import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Queue } from "bullmq";
import {
  ConflictError,
  GroupNotMemberError,
  MontageAlreadyGeneratingError,
  MontageNotFoundError,
  NotEnoughMediaError,
  RecapAlreadyTodayError,
  createMontageReqSchema,
  isValidTimezone,
  montageOptionsResSchema,
  publishMontageReqSchema,
  publishMontageResSchema,
  regenerateMontageReqSchema,
  resolveDayBucket,
  themeEnum,
  type CreateMontageRes,
  type MontageDTO,
  type MontageStatus,
  type PublishMontageRes,
  type Theme,
} from "@twenty4/contracts";
import { dailyMediaItem, montage, montageGroupVisibility, user } from "@twenty4/contracts/db";
import { presignMontageGet, presignThumbGet, type S3Deps } from "../media/s3.ts";
import { activeMembership } from "../groups/authz.ts";
import { enqueueRenderMontage, renderMontageJobId, type RenderMontageJobData } from "./queue.ts";
import { DEFAULT_THEME, defaultMusicId, loadTracks } from "./manifest.ts";
import type { DbClient } from "../db.ts";
import type { makeRequireSession } from "../auth/guards.ts";

export interface MontageRoutesDeps {
  db: DbClient;
  requireSession: ReturnType<typeof makeRequireSession>;
  s3: S3Deps;
  queue: Queue<RenderMontageJobData>;
  // Min valid items required to generate (env MONTAGE_MIN_MEDIA, default 3).
  minMedia: number;
  // Locates the bundled-music manifest (env INFRA_REMOTION_DIR).
  remotionDir: string;
}

type MontageRow = typeof montage.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
// The constant retryable copy surfaced on MontageDTO.error when status=failed.
const RENDER_FAILED_MESSAGE = "Render failed — please try again.";

// Normalize an absent/empty body to {} so the all-optional generate/regenerate
// schemas accept a bodyless POST (a no-body client, or a content-type:json client
// that sent no payload — the `*` parser can hand us undefined or an empty string).
function bodyOrEmpty(body: unknown): unknown {
  if (body === undefined || body === null || body === "") return {};
  return body;
}

// Resolve the caller's CURRENT day_bucket the same way GET /media/today does:
// from the SERVER-anchored canonical tz (user.timezone), falling back to UTC.
async function todayBucketFor(db: DbClient, userId: string): Promise<string> {
  const urows = await db.db.select({ timezone: user.timezone }).from(user).where(eq(user.id, userId)).limit(1);
  const canonicalTz = urows[0]?.timezone ?? null;
  const tz = canonicalTz && isValidTimezone(canonicalTz) ? canonicalTz : "UTC";
  return resolveDayBucket(new Date(), tz);
}

// Load a montage and assert the caller owns it. Throws MONTAGE_NOT_FOUND otherwise
// (owner-only routes must not leak existence to non-owners — same 404 for missing
// and not-owned, mirroring media's loadOwnedRow).
async function loadOwnedMontage(db: DbClient, id: string, userId: string): Promise<MontageRow> {
  const rows = await db.db.select().from(montage).where(eq(montage.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.userId !== userId) throw new MontageNotFoundError();
  return row;
}

// The transaction-scoped advisory lock keyed on (user, day_bucket) — serializes
// concurrent generate/regenerate/publish for the SAME user-day so the find-or-
// create + one-recap checks are race-free (auto-released at commit/rollback).
// Mirrors media init's TOCTOU guard.
function lockUserDay(tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0], userId: string, dayBucket: string) {
  return tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text || ':' || ${dayBucket}::text, 0))`,
  );
}

// The set of the user's VALID, non-deleted media ids for a day_bucket (the render
// candidate pool). When `requested` ids are given, intersect — only valid + owned
// + today ids survive; foreign/invalid ids are silently ignored.
async function resolveChosenMedia(
  tx: Parameters<Parameters<DbClient["db"]["transaction"]>[0]>[0],
  userId: string,
  dayBucket: string,
  requested: string[] | undefined,
): Promise<string[]> {
  const rows = await tx
    .select({ id: dailyMediaItem.id })
    .from(dailyMediaItem)
    .where(
      and(
        eq(dailyMediaItem.userId, userId),
        eq(dailyMediaItem.dayBucket, dayBucket),
        eq(dailyMediaItem.validationStatus, "valid"),
        sql`${dailyMediaItem.processingStatus} <> 'deleted'`,
      ),
    );
  const valid = rows.map((r) => r.id);
  if (!requested) return valid;
  const validSet = new Set(valid);
  return requested.filter((id) => validSet.has(id));
}

// Build the wire DTO. previewUrl is signed ONLY for draft_ready/published rows
// with a video_path; thumbnailUrl whenever a thumbnail_path exists. Both signed-URL
// TTLs are capped at the download TTL AND the montage's remaining lifetime (a
// published recap's URLs must not outlive expiry_at).
async function toMontageDto(s3: S3Deps, row: MontageRow): Promise<MontageDTO> {
  let ttl = s3.downloadTtlSec;
  if (row.expiryAt) {
    const remaining = Math.floor((row.expiryAt.getTime() - Date.now()) / 1000);
    ttl = Math.max(1, Math.min(ttl, remaining));
  }
  const previewReady = (row.status === "draft_ready" || row.status === "published") && !!row.videoPath;
  const previewUrl = previewReady && row.videoPath ? await presignMontageGet(s3, row.videoPath, ttl) : null;
  return {
    id: row.id,
    status: row.status,
    dayBucket: String(row.dayBucket),
    theme: row.theme as Theme,
    musicId: row.musicId,
    durationMs: row.durationMs ?? null,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    expiryAt: row.expiryAt ? row.expiryAt.toISOString() : null,
    previewUrl,
    thumbnailUrl: row.thumbnailPath ? await presignThumbGet(s3, row.thumbnailPath, ttl) : null,
    error: row.status === "failed" ? RENDER_FAILED_MESSAGE : null,
    sourceMediaIds: row.sourceMediaIds,
  };
}

export async function registerMontageRoutes(app: FastifyInstance, deps: MontageRoutesDeps): Promise<void> {
  const { db, requireSession, s3, queue, minMedia, remotionDir } = deps;

  // ── POST /montages (generate today's recap) ─────────────────────────────────
  // Find-or-create one recap per (user, today). Status machine:
  //   - existing generating/draft_ready/published → return it (202), NO re-enqueue
  //     (idempotent; jobId dedup also protects). One recap per user/day.
  //   - existing failed/not_generated → reuse the row → generating → enqueue.
  //   - none → create a new generating row → enqueue.
  // The claim is released on enqueue-throw (delete a just-created row / restore a
  // reused row's prior status), mirroring media's catch-rollback.
  app.post("/montages", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    // All fields optional → an empty/absent body is valid (defaults applied).
    const body = createMontageReqSchema.parse(bodyOrEmpty(req.body));
    const u = req.user!;
    const dayBucket = await todayBucketFor(db, u.id);

    const tracks = loadTracks(remotionDir);
    const theme: Theme = body.theme ?? DEFAULT_THEME;
    const musicId = body.musicId ?? defaultMusicId(theme, tracks);

    const decision = await db.db.transaction(async (tx) => {
      await lockUserDay(tx, u.id, dayBucket);

      const existingRows = await tx
        .select()
        .from(montage)
        .where(and(eq(montage.userId, u.id), eq(montage.dayBucket, dayBucket)))
        .limit(1);
      const existing = existingRows[0];

      // Already in-flight or already rendered/published → idempotent return.
      if (
        existing &&
        (existing.status === "generating" ||
          existing.status === "draft_ready" ||
          existing.status === "published")
      ) {
        return { row: existing, action: "none" as const };
      }

      // From here on we WILL render — resolve the candidate media + enforce the floor.
      const chosen = await resolveChosenMedia(tx, u.id, dayBucket, body.mediaIds);
      if (chosen.length < minMedia) {
        throw new NotEnoughMediaError(`Need at least ${minMedia} valid items to generate (have ${chosen.length})`);
      }

      // Reuse a failed/not_generated row (one recap per user/day), else create.
      if (existing) {
        const updated = await tx
          .update(montage)
          .set({ status: "generating", sourceMediaIds: chosen, theme, musicId })
          .where(eq(montage.id, existing.id))
          .returning();
        return { row: updated[0]!, action: "reuse" as const, prior: existing.status };
      }

      const inserted = await tx
        .insert(montage)
        .values({ userId: u.id, dayBucket, status: "generating", theme, musicId, sourceMediaIds: chosen })
        .returning();
      return { row: inserted[0]!, action: "create" as const };
    });

    // Idempotent path: existing in-flight/done row — return without re-enqueue.
    if (decision.action === "none") {
      const res: CreateMontageRes = { montageId: decision.row.id, status: decision.row.status };
      reply.status(202).send(res);
      return;
    }

    // We claimed a render — enqueue exactly once. Release the claim on throw.
    try {
      await enqueueRenderMontage(queue, decision.row.id);
      await db.db
        .update(montage)
        .set({ renderJobId: renderMontageJobId(decision.row.id) })
        .where(eq(montage.id, decision.row.id));
    } catch (err) {
      if (decision.action === "create") {
        await db.db.delete(montage).where(eq(montage.id, decision.row.id));
      } else {
        await db.db
          .update(montage)
          .set({ status: decision.prior })
          .where(eq(montage.id, decision.row.id));
      }
      throw err;
    }

    const res: CreateMontageRes = { montageId: decision.row.id, status: "generating" };
    reply.status(202).send(res);
  });

  // ── GET /montages/options (theme + music picker feed) ───────────────────────
  // Public-to-authed. Registered before the parametric /montages/:id (find-my-way
  // prioritizes static routes regardless, but keep it explicit).
  app.get("/montages/options", { preHandler: requireSession }, async (_req: FastifyRequest, reply: FastifyReply) => {
    const tracks = loadTracks(remotionDir);
    const res = montageOptionsResSchema.parse({ themes: themeEnum.options, tracks });
    reply.status(200).send(res);
  });

  // ── GET /montages/:id (the client poll target) ──────────────────────────────
  // Owner-only. Returns the status machine + signed preview/thumbnail URLs once
  // draft_ready/published. Missing OR not-owned → 404 (no existence leak).
  app.get("/montages/:id", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const u = req.user!;
    const row = await loadOwnedMontage(db, id, u.id);
    reply.status(200).send(await toMontageDto(s3, row));
  });

  // ── POST /montages/:id/regenerate ───────────────────────────────────────────
  // Owner-only. Concurrency-guarded (generating → 409 MONTAGE_ALREADY_GENERATING).
  // A published montage may NOT be regenerated (409 CONFLICT — re-rendering would
  // silently unpublish + reset the 24h ephemerality clock on a later republish).
  // Optional mediaIds → remove-media-and-regenerate (re-resolve the valid+today
  // subset, enforce the floor). Optional theme/musicId → re-render with a new look
  // (omitted ⇒ keep the row's current value). Re-enqueue (jobId dedup makes it
  // free). Release on throw.
  app.post(
    "/montages/:id/regenerate",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      // mediaIds optional → an empty/absent body is valid (re-render as-is).
      const body = regenerateMontageReqSchema.parse(bodyOrEmpty(req.body));

      const decision = await db.db.transaction(async (tx) => {
        const rows = await tx.select().from(montage).where(eq(montage.id, id)).limit(1);
        const row = rows[0];
        if (!row || row.userId !== u.id) throw new MontageNotFoundError();

        await lockUserDay(tx, u.id, String(row.dayBucket));

        // Re-read under the lock so a racing generate/regenerate can't slip past.
        const freshRows = await tx.select().from(montage).where(eq(montage.id, id)).limit(1);
        const fresh = freshRows[0]!;
        if (fresh.status === "generating") throw new MontageAlreadyGeneratingError();
        if (fresh.status === "published") throw new ConflictError("Cannot regenerate a published montage.");

        let chosen = fresh.sourceMediaIds;
        if (body.mediaIds) {
          chosen = await resolveChosenMedia(tx, u.id, String(fresh.dayBucket), body.mediaIds);
          if (chosen.length < minMedia) {
            throw new NotEnoughMediaError(
              `Need at least ${minMedia} valid items to regenerate (have ${chosen.length})`,
            );
          }
        }

        const updated = await tx
          .update(montage)
          .set({
            status: "generating",
            sourceMediaIds: chosen,
            // Honor a picker re-theme/re-track; keep the current value when omitted.
            ...(body.theme ? { theme: body.theme } : {}),
            ...(body.musicId ? { musicId: body.musicId } : {}),
          })
          .where(eq(montage.id, id))
          .returning();
        return { row: updated[0]!, prior: fresh.status };
      });

      try {
        await enqueueRenderMontage(queue, id);
        await db.db.update(montage).set({ renderJobId: renderMontageJobId(id) }).where(eq(montage.id, id));
      } catch (err) {
        await db.db.update(montage).set({ status: decision.prior }).where(eq(montage.id, id));
        throw err;
      }

      const res: CreateMontageRes = { montageId: decision.row.id, status: "generating" };
      reply.status(202).send(res);
    },
  );

  // ── POST /montages/:id/publish ──────────────────────────────────────────────
  // Owner-only. Precondition: status must be draft_ready (or already published for
  // idempotency) — any other status is a CONFLICT (409; MONTAGE_ALREADY_GENERATING
  // would be the wrong semantics, and no montage-specific publish-precondition code
  // exists, so we reuse the generic 409). For each group: membership-checked
  // (GROUP_NOT_MEMBER via the shared activeMembership gate). One recap per user/
  // group/day (RECAP_ALREADY_TODAY). Visibility rows are idempotent (composite PK
  // → onConflictDoNothing). The whole publish is transactional; an idempotent
  // re-publish keeps the original published_at/expiry_at.
  app.post(
    "/montages/:id/publish",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      const body = publishMontageReqSchema.parse(req.body);

      // Owner + precondition (read via db).
      const row = await loadOwnedMontage(db, id, u.id);
      if (row.status !== "draft_ready" && row.status !== "published") {
        throw new ConflictError("Montage is not ready to publish");
      }

      // Membership of EACH target group (shared authz gate → GROUP_NOT_MEMBER 403).
      for (const groupId of body.groupIds) {
        const m = await activeMembership(db, groupId, u.id);
        if (!m) throw new GroupNotMemberError();
      }

      const result = await db.db.transaction(async (tx) => {
        await lockUserDay(tx, u.id, String(row.dayBucket));

        // One recap per (user, group, day): reject if ANOTHER montage of this user
        // for the same day_bucket is already visible in a target group.
        for (const groupId of body.groupIds) {
          const clash = await tx
            .select({ mid: montageGroupVisibility.montageId })
            .from(montageGroupVisibility)
            .innerJoin(montage, eq(montage.id, montageGroupVisibility.montageId))
            .where(
              and(
                eq(montageGroupVisibility.groupId, groupId),
                eq(montage.userId, u.id),
                eq(montage.dayBucket, String(row.dayBucket)),
                ne(montageGroupVisibility.montageId, id),
              ),
            )
            .limit(1);
          if (clash[0]) throw new RecapAlreadyTodayError();
        }

        // Idempotent visibility insert (composite PK collapses re-publish to a no-op).
        await tx
          .insert(montageGroupVisibility)
          .values(body.groupIds.map((groupId) => ({ montageId: id, groupId })))
          .onConflictDoNothing();

        // Set published once; an idempotent re-publish keeps the original timestamps.
        let publishedAt = row.publishedAt;
        let expiryAt = row.expiryAt;
        if (row.status !== "published") {
          publishedAt = new Date();
          expiryAt = new Date(publishedAt.getTime() + DAY_MS);
          await tx
            .update(montage)
            .set({ status: "published", publishedAt, expiryAt })
            .where(eq(montage.id, id));
        }

        // The FULL current visibility set (the response groupIds).
        const visRows = await tx
          .select({ groupId: montageGroupVisibility.groupId })
          .from(montageGroupVisibility)
          .where(eq(montageGroupVisibility.montageId, id));

        return { publishedAt: publishedAt!, expiryAt: expiryAt!, groupIds: visRows.map((r) => r.groupId) };
      });

      const res: PublishMontageRes = {
        id,
        status: "published" satisfies MontageStatus,
        publishedAt: result.publishedAt.toISOString(),
        expiryAt: result.expiryAt.toISOString(),
        groupIds: result.groupIds,
      };
      reply.status(200).send(publishMontageResSchema.parse(res));
    },
  );
}
