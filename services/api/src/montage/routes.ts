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
  downloadUrlResSchema,
  isValidTimezone,
  montageOptionsResSchema,
  publishMontageReqSchema,
  publishMontageResSchema,
  regenerateMontageReqSchema,
  replaceMontageReqSchema,
  replaceMontageResSchema,
  resolveDayBucket,
  themeEnum,
  type CreateMontageRes,
  type DownloadUrlRes,
  type MontageDTO,
  type MontageStatus,
  type PublishMontageRes,
  type ReplaceMontageRes,
  type Theme,
} from "@twenty4/contracts";
import { dailyMediaItem, montage, montageGroupVisibility, user } from "@twenty4/contracts/db";
import { presignMontageGet, presignThumbGet, type S3Deps } from "../media/s3.ts";
import { activeMembership } from "../groups/authz.ts";
import { enqueueRenderMontage, renderMontageJobId, type RenderMontageJobData } from "./queue.ts";
import {
  cancelExpireMontage,
  enqueueDeleteMontage,
  enqueueExpireMontage,
  enqueueRawPurge,
  type CleanupQueues,
} from "../cleanup/queue.ts";
import { DEFAULT_THEME, defaultMusicId, loadTracks } from "./manifest.ts";
import type { DbClient } from "../db.ts";
import type { makeRequireSession } from "../auth/guards.ts";

export interface MontageRoutesDeps {
  db: DbClient;
  requireSession: ReturnType<typeof makeRequireSession>;
  s3: S3Deps;
  queue: Queue<RenderMontageJobData>;
  // M9 cleanup pipeline — the expire/raw-purge/delete enqueue side (the worker
  // consumes). Optional so an M1-only / no-redis test can still register routes.
  cleanupQueues?: CleanupQueues;
  // Min valid items required to generate (env MONTAGE_MIN_MEDIA, default 3).
  minMedia: number;
  // M9 ephemerality clock (env, shortened in the §6 suite): published_at + this =
  // expiry_at + the delayed expire-job delay (hours), and the raw-purge grace (min).
  expiryHours: number;
  // Optional sub-hour override (seconds) — WINS over expiryHours when set (undefined
  // ⇒ keep the 24h-default contract). Enables the ~2-min on-device lifetime (spec §8).
  expirySec?: number;
  rawPurgeGraceMin: number;
  // Locates the bundled-music manifest (env INFRA_REMOTION_DIR).
  remotionDir: string;
}

type MontageRow = typeof montage.$inferSelect;

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
  let expired = false;
  if (row.expiryAt) {
    const remaining = Math.floor((row.expiryAt.getTime() - Date.now()) / 1000);
    // Past expiry (expired-but-not-yet-swept): do NOT presign — a leaked 1s self-
    // preview URL must die with the content, mirroring GET …/download-url's post-
    // expiry 404. Only clamp when there is real lifetime left (remaining >= 1).
    if (remaining <= 0) expired = true;
    else ttl = Math.min(ttl, remaining);
  }
  const previewReady = !expired && (row.status === "draft_ready" || row.status === "published") && !!row.videoPath;
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
    thumbnailUrl: !expired && row.thumbnailPath ? await presignThumbGet(s3, row.thumbnailPath, ttl) : null,
    error: row.status === "failed" ? RENDER_FAILED_MESSAGE : null,
    sourceMediaIds: row.sourceMediaIds,
  };
}

export async function registerMontageRoutes(app: FastifyInstance, deps: MontageRoutesDeps): Promise<void> {
  const { db, requireSession, s3, queue, cleanupQueues, minMedia, expiryHours, expirySec, rawPurgeGraceMin, remotionDir } = deps;
  // Resolve the publish→expiry span once: a set MONTAGE_EXPIRY_SEC (sub-hour) WINS
  // over MONTAGE_EXPIRY_HOURS; unset ⇒ the unchanged 24h-default contract. The expire-
  // job delay is derived downstream from (expiry_at - now), so short spans just work.
  const expiryMs = expirySec !== undefined ? expirySec * 1000 : expiryHours * 60 * 60 * 1000;
  const rawPurgeGraceMs = rawPurgeGraceMin * 60 * 1000;

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
        // for the same day_bucket is already visible in a target group. EXCEPTION:
        // a prior montage being REPLACED by this one (prior.superseded_by = id) is
        // NOT a clash — the replacement publishes into the same group the prior holds,
        // then the prior is hard-deleted on this publish (M9 replace contract). `IS
        // DISTINCT FROM` keeps a normal clash (superseded_by NULL or some other id)
        // while excluding only the prior this publish supersedes.
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
                sql`${montage.supersededBy} IS DISTINCT FROM ${id}::uuid`,
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
        // expiry_at = published_at + expiryMs (MONTAGE_EXPIRY_SEC override when set, else
        // MONTAGE_EXPIRY_HOURS; env-shortened in the §6 suite); the DB CHECK guarantees a
        // published row always carries an expiry.
        let publishedAt = row.publishedAt;
        let expiryAt = row.expiryAt;
        const firstPublish = row.status !== "published";
        if (firstPublish) {
          publishedAt = new Date();
          expiryAt = new Date(publishedAt.getTime() + expiryMs);
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

        return {
          firstPublish,
          publishedAt: publishedAt!,
          expiryAt: expiryAt!,
          groupIds: visRows.map((r) => r.groupId),
        };
      });

      // M9 publish-time enqueue wiring — first publish ONLY (an idempotent
      // re-publish must NOT re-arm the clock or re-run replace-completion).
      if (result.firstPublish) {
        // (1) Delayed expire-montage — the authoritative 24h hard-delete clock.
        const expireDelay = Math.max(0, result.expiryAt.getTime() - Date.now());
        await enqueueExpireMontage(cleanupQueues, id, expireDelay);
        // (2) Delayed raw-media purge (+grace) for this user/day's source media.
        await enqueueRawPurge(cleanupQueues, {
          montageId: id,
          dayBucket: String(row.dayBucket),
          userId: u.id,
          delayMs: rawPurgeGraceMs,
        });
        // (3) Replace-completion — if THIS montage superseded a prior (prior.
        // superseded_by = id was set at replace time), the prior is now unambiguously
        // dead: hard-delete it + best-effort cancel its (now-stale) expire job. The
        // sweep reclaims the prior even if this delete is dropped (§6 regression #1).
        const priors = await db.db
          .select({ id: montage.id })
          .from(montage)
          .where(eq(montage.supersededBy, id));
        for (const p of priors) {
          await enqueueDeleteMontage(cleanupQueues, p.id, "replaced");
          await cancelExpireMontage(cleanupQueues, p.id);
        }
      }

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

  // ── POST /montages/:id/replace (M9 replace-before-expiry) ────────────────────
  // Owner-only. `:id` is the PRIOR (currently-published) montage. Generates a NEW
  // montage (status=generating, same render pipeline as POST /montages) and points
  // the prior at it IMMEDIATELY (prior.superseded_by = new.id) — the shared supersede
  // contract. The prior STAYS published + feed-served until the new one publishes
  // (its render could fail; the prior must remain live). On the new montage's publish
  // success the prior is hard-deleted (handled in publish above). Idempotent: a
  // double-replace whose prior already points at a still-alive successor returns that
  // successor rather than spawning another (advisory-lock-serialized, M8 lever).
  app.post("/montages/:id/replace", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const u = req.user!;
    const body = replaceMontageReqSchema.parse(bodyOrEmpty(req.body));

    // Owner + precondition (only a published montage can be replaced).
    const prior = await loadOwnedMontage(db, id, u.id);
    if (prior.status !== "published") {
      throw new ConflictError("Only a published montage can be replaced");
    }

    const theme: Theme = body.theme ?? (prior.theme as Theme);
    const musicId = body.musicId ?? prior.musicId;

    const decision = await db.db.transaction(async (tx) => {
      await lockUserDay(tx, u.id, String(prior.dayBucket));

      // Re-read the prior under the lock so a racing replace can't double-spawn.
      const freshRows = await tx.select().from(montage).where(eq(montage.id, id)).limit(1);
      const fresh = freshRows[0];
      if (!fresh || fresh.userId !== u.id) throw new MontageNotFoundError();

      // Idempotency: already superseded by a STILL-ALIVE successor → return it.
      if (fresh.supersededBy) {
        const succRows = await tx.select().from(montage).where(eq(montage.id, fresh.supersededBy)).limit(1);
        const succ = succRows[0];
        if (succ) return { row: succ, action: "none" as const };
        // Successor gone (e.g. its render failed and it was deleted) → re-spawn.
      }

      // Resolve the replacement's candidate media from the prior's day_bucket.
      const chosen = await resolveChosenMedia(tx, u.id, String(fresh.dayBucket), body.mediaIds);
      if (chosen.length < minMedia) {
        throw new NotEnoughMediaError(`Need at least ${minMedia} valid items to replace (have ${chosen.length})`);
      }

      const inserted = await tx
        .insert(montage)
        .values({ userId: u.id, dayBucket: String(fresh.dayBucket), status: "generating", theme, musicId, sourceMediaIds: chosen })
        .returning();
      const newRow = inserted[0]!;
      // Point the prior at the new montage NOW (the supersede contract): even if the
      // prior's expire job is later lost, sweep-expiries reclaims it (superseded_by
      // set + successor published).
      await tx.update(montage).set({ supersededBy: newRow.id }).where(eq(montage.id, id));
      return { row: newRow, action: "create" as const };
    });

    // Already-superseded idempotent path — return the live successor, no re-enqueue.
    if (decision.action === "none") {
      const res: ReplaceMontageRes = { montageId: decision.row.id, status: decision.row.status };
      reply.status(202).send(replaceMontageResSchema.parse(res));
      return;
    }

    // We claimed a render — enqueue exactly once. On throw, release the claim: clear
    // the prior's superseded_by pointer + drop the just-created row (keeps the prior
    // live + replaceable; mirrors generate's catch-rollback).
    try {
      await enqueueRenderMontage(queue, decision.row.id);
      await db.db.update(montage).set({ renderJobId: renderMontageJobId(decision.row.id) }).where(eq(montage.id, decision.row.id));
    } catch (err) {
      await db.db.update(montage).set({ supersededBy: null }).where(eq(montage.id, id));
      await db.db.delete(montage).where(eq(montage.id, decision.row.id));
      throw err;
    }

    const res: ReplaceMontageRes = { montageId: decision.row.id, status: "generating" };
    reply.status(202).send(replaceMontageResSchema.parse(res));
  });

  // ── DELETE /montages/:id (M9 manual hard-delete) ─────────────────────────────
  // Owner-only. Enqueues delete-montage (reason=deleted_by_user); the worker runs
  // deleteMontageHard (S3-first then the row + child cascade + tombstone). Returns
  // fast (202 {status:"deleting"}); sweep-expiries is the backstop if the job drops.
  // Missing OR not-owned → the SAME 404 (no existence leak). Idempotent: the
  // deterministic jobId dedups a double-delete.
  app.delete("/montages/:id", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const u = req.user!;
    await loadOwnedMontage(db, id, u.id); // 404 on missing / not-owned
    await enqueueDeleteMontage(cleanupQueues, id, "deleted_by_user");
    reply.status(202).send({ status: "deleting" });
  });

  // ── GET /montages/:id/download-url (M9 clamped presign) ──────────────────────
  // Owner-only short-TTL signed GET of the rendered montage, with the TTL CLAMPED to
  // the recap's remaining lifetime (min(defaultTtl, expiry_at - now)) so a leaked URL
  // dies with the content. Not-ready / no video / EXPIRED / gone → 404 (no-leak,
  // mirroring media + the M8 feed surface).
  app.get(
    "/montages/:id/download-url",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      const row = await loadOwnedMontage(db, id, u.id);
      if (!row.videoPath || (row.status !== "draft_ready" && row.status !== "published")) {
        throw new MontageNotFoundError("Montage is not available for download");
      }
      let ttl = s3.downloadTtlSec;
      if (row.expiryAt) {
        const remaining = Math.floor((row.expiryAt.getTime() - Date.now()) / 1000);
        if (remaining <= 0) throw new MontageNotFoundError("Montage has expired");
        ttl = Math.min(ttl, remaining);
      }
      const downloadUrl = await presignMontageGet(s3, row.videoPath, ttl);
      const res: DownloadUrlRes = { id: row.id, downloadUrl, expiresInSec: ttl };
      reply.status(200).send(downloadUrlResSchema.parse(res));
    },
  );
}
