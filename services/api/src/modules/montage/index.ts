/**
 * montage module (§8 Montages) — Slice 5: generate → render → review → publish,
 * plus regenerate, options, and replace/republish. WIRES the Slice-1 render
 * pipeline to real user media (the worker `render-montage` job consumes the row +
 * the user's VALID daily media; this module owns the API surface + lifecycle).
 *
 * Routes (all require a valid, active session via `requireSession`):
 *
 *   POST   /montages                generate — require ≥ MONTAGE_MIN_VALID_MEDIA
 *                                   VALID items in TODAY's bucket; create a
 *                                   `generating` row; enqueue `render-montage`.
 *   GET    /montages/options        themes (enum) + music tracks (id/label/bpm)
 *                                   for the 2.6/2.7 pickers.
 *   GET    /montages/:id            owner-only status poll (§7.3); presigned
 *                                   video+thumbnail GETs once draft_ready/published
 *                                   (TTL ≤ remaining lifetime).
 *   POST   /montages/:id/regenerate owner-only; only while draft_ready/failed;
 *                                   accept new theme/music; reset → generating;
 *                                   re-enqueue render.
 *   POST   /montages/:id/publish    owner-only; assertMemberOf EACH group;
 *                                   IDEMPOTENT (natural key or Idempotency-Key);
 *                                   status=published, published_at=now,
 *                                   expiry_at=now+24h; insert visibility rows
 *                                   (one render → many groups); enqueue delayed
 *                                   expire-montage(+24h) + cleanup-raw(+60min).
 *   POST   /montages/:id/replace    owner-only; publish a freshly-generated
 *                                   replacement, mark the prior montage superseded
 *                                   (full cascade delete is Slice 7). Idempotent.
 *
 * Security invariants:
 *   - every montage is OWNER-scoped: a non-owner (or missing/expired) → 404, no
 *     existence leak (mirrors the media module's owner-only reads).
 *   - publish requires active membership in EVERY target group (assertMemberOf);
 *     a single non-member group rejects the whole publish (atomic).
 *   - presigned GET TTLs are clamped to the content's remaining lifetime so a
 *     leaked URL 404s once the montage expires/purges (§6/§11).
 *   - theme/music live on the SERVER row (set here), never trusted from the worker.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  montages,
  montageGroupVisibility,
  dailyMediaItems,
  type Montage,
} from '@twenty4/contracts/db';
import {
  generateMontageRequestSchema,
  regenerateMontageRequestSchema,
  publishMontageRequestSchema,
  replaceMontageRequestSchema,
  montageResponseSchema,
  montageGeneratingResponseSchema,
  montageOptionsResponseSchema,
  downloadUrlResponseSchema,
  type MontageResponse,
} from '@twenty4/contracts/dto';
import { THEMES, type Theme } from '@twenty4/contracts/enums';
import { errors } from '@twenty4/contracts/errors';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import { TRACKS, TRACK_IDS } from '@twenty4/remotion/tracks';

import { requireSession } from '../../auth/middleware.js';
import { assertMemberOf } from '../../authz/groupMembership.js';
import { db } from '../../db/index.js';
import { env } from '../../env.js';
import { buckets, presignGet } from '../../storage/s3.js';
import { withIdempotency, hashBody } from '../../lib/idempotency.js';
import { throttleRenderTrigger } from '../../lib/rateLimit.js';
import {
  enqueueRenderMontage,
  enqueueExpireMontage,
  enqueueCleanupRaw,
  enqueueSupersedeCleanup,
  removeExpireMontage,
} from '../../queue/producers.js';

/** Default theme/music when the client doesn't pick (review screen defaults). */
const DEFAULT_THEME: Theme = 'Random';
const DEFAULT_MUSIC_ID = TRACK_IDS[0]!; // first bundled track (chill_90)

/** Default day-bucket tz when a client omits it: UTC (server-authoritative). */
const DEFAULT_TZ = 'UTC';

/** A montage that is still in flight / awaiting review (blocks a 2nd generate). */
const ACTIVE_STATUSES = ['generating', 'draft_ready'] as const;

/** Cheap uuid shape guard so a malformed :id 404s instead of erroring on the cast. */
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Remaining-lifetime expiry for a montage row (for the presign TTL clamp). */
function montageExpiry(row: Pick<Montage, 'expiryAt' | 'createdAt'>): Date {
  if (row.expiryAt) return row.expiryAt;
  // Pre-publish (draft) content has no 24h clock yet; use a safety ceiling so a
  // draft preview URL still can't outlive the content's eventual purge.
  return new Date(row.createdAt.getTime() + env.MONTAGE_LIFETIME_HOURS * 3600 * 1000);
}

/** Resolve the caller's tz from query (?tz=) → day bucket; falls back to UTC. */
function resolveTzBucket(req: FastifyRequest): string {
  const q = req.query as { tz?: string };
  const tz = q.tz ?? DEFAULT_TZ;
  try {
    return resolveDayBucket(new Date(), tz, env.DAY_WINDOW_OFFSET_HOURS);
  } catch {
    throw errors.validation('invalid timezone', { tz });
  }
}

/**
 * Project a montage row → the poll/view DTO. When the montage has rendered
 * (draft_ready / published) we presign video + thumbnail GETs, clamped to the
 * remaining lifetime. Expired/deleted/failed/generating → no URLs.
 */
async function toMontageResponse(row: Montage): Promise<MontageResponse> {
  let videoUrl: string | null = null;
  let thumbnailUrl: string | null = null;

  const playable =
    (row.status === 'draft_ready' || row.status === 'published') &&
    !!row.videoPath;
  if (playable) {
    const expiry = montageExpiry(row);
    const vid = await presignGet(buckets.montages, row.videoPath!, { expiryAt: expiry });
    videoUrl = vid.url;
    if (row.thumbnailPath) {
      const thumb = await presignGet(buckets.thumbnails, row.thumbnailPath, {
        expiryAt: expiry,
      });
      thumbnailUrl = thumb.url;
    }
  }

  return montageResponseSchema.parse({
    id: row.id,
    userId: row.userId,
    status: row.status,
    theme: row.theme ?? null,
    musicId: row.musicId ?? null,
    durationMs: row.durationMs ?? null,
    videoUrl,
    thumbnailUrl,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    expiryAt: row.expiryAt ? row.expiryAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Load a montage the caller OWNS, or throw 404. A non-owner gets the SAME 404 as a
 * missing row (no existence leak) — we never reveal the id exists for another user.
 */
async function loadOwnedOr404(id: string, userId: string): Promise<Montage> {
  if (!isUuid(id)) throw errors.notFound('montage not found');
  const [row] = await db
    .select()
    .from(montages)
    .where(and(eq(montages.id, id), eq(montages.userId, userId)))
    .limit(1);
  if (!row) throw errors.notFound('montage not found');
  return row;
}

/** Count the caller's VALID media items in a day bucket (gates generate). */
async function countValidMedia(userId: string, dayBucket: string): Promise<number> {
  const rows = (await db.execute(sql`
    select count(*)::int as n
    from daily_media_item
    where user_id = ${userId}
      and day_bucket = ${dayBucket}
      and validation_status = 'valid'
      and processing_status <> 'deleted'
  `)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Validate a caller's SELECTED media ids and return them deduped. EVERY submitted
 * id must be the caller's OWN, `validation_status='valid'`, in TODAY's day bucket,
 * and not deleted — otherwise we reject 422 (never silently drop a bad id). Returns
 * the deduped, validated id list (preserving the caller's order) to persist on the
 * montage so the render job uses EXACTLY this selection.
 */
async function resolveSelectedMedia(
  userId: string,
  dayBucket: string,
  mediaIds: string[],
): Promise<string[]> {
  // Dedupe (a caller can't smuggle duplicates) while preserving first-seen order.
  const wanted = [...new Set(mediaIds)];

  // The set of submitted ids that ARE the caller's valid, today, not-deleted media.
  const rows = (await db.execute(sql`
    select id::text as id
    from daily_media_item
    where user_id = ${userId}
      and day_bucket = ${dayBucket}
      and validation_status = 'valid'
      and processing_status <> 'deleted'
      and id in (${sql.join(wanted.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as Array<{ id: string }>;
  const eligible = new Set(rows.map((r) => r.id));

  const rejected = wanted.filter((id) => !eligible.has(id));
  if (rejected.length > 0) {
    // Reject loudly — a selected id that isn't owned/valid/today/live must NOT be
    // silently dropped (the user would get a montage missing what they picked).
    throw errors.validation(
      'one or more selected media items are not your own valid media for today',
      { rejected },
    );
  }
  return wanted;
}

/** Validate a music id against the bundled registry (reject unknown loudly). */
function assertKnownMusic(musicId: string): void {
  if (!TRACKS[musicId]) {
    throw errors.validation('unknown music track', {
      musicId,
      known: TRACK_IDS,
    });
  }
}

export const montageModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireSession);

  /* ----------------------------- GET /montages/options ---------------------- */
  // Themes (from the enum) + bundled music tracks for the 2.6/2.7 pickers. Static
  // (no per-user state) but behind the session so anonymous callers can't scrape it.
  app.get('/options', async (_req, reply) => {
    const music = TRACK_IDS.map((id) => {
      const t = TRACKS[id]!;
      return { id: t.id, label: t.title, bpm: t.bpm, synthesized: t.synthesized };
    });
    reply.code(200);
    return montageOptionsResponseSchema.parse({
      themes: [...THEMES],
      defaultTheme: DEFAULT_THEME,
      music,
      defaultMusicId: DEFAULT_MUSIC_ID,
    });
  });

  /* -------------------------------- POST /montages -------------------------- */
  // Generate. Requires ≥ MONTAGE_MIN_VALID_MEDIA VALID items in today's bucket.
  // Rejects a 2nd concurrent generate for today (one active montage at a time) —
  // the client must regenerate or replace instead.
  app.post('/', async (req, reply) => {
    const me = req.user!;
    const body = generateMontageRequestSchema.parse(req.body);
    assertKnownMusic(body.musicId);

    // Render-storm guard: cap render triggers per user BEFORE any expensive work or
    // enqueue (renders are scarce — worker concurrency 1, ~25-30s each). 429 over cap.
    await throttleRenderTrigger({ userId: me.id });

    const dayBucket = resolveTzBucket(req);

    // Gate on the caller's VALID media for TODAY (server-authoritative count). The
    // worker independently re-reads the valid pool, so this is a fast-fail guard.
    const validCount = await countValidMedia(me.id, dayBucket);
    if (validCount < env.MONTAGE_MIN_VALID_MEDIA) {
      throw errors.conflict('not enough valid media to generate a montage', {
        validCount,
        required: env.MONTAGE_MIN_VALID_MEDIA,
      });
    }

    // Honor the caller's SELECTION: every submitted id must be their own valid,
    // today's, not-deleted media (reject 422 on any bad id — never silently drop).
    // The validated set is persisted on the row so the render job uses EXACTLY it.
    const selectedMediaIds = await resolveSelectedMedia(me.id, dayBucket, body.mediaIds);

    // One active (generating/draft_ready) montage per (user, day_bucket): a 2nd
    // generate while one is in flight is a conflict (regenerate/replace instead).
    const [active] = await db
      .select({ id: montages.id, status: montages.status })
      .from(montages)
      .where(
        and(
          eq(montages.userId, me.id),
          eq(montages.dayBucket, dayBucket),
          inArray(montages.status, [...ACTIVE_STATUSES]),
        ),
      )
      .limit(1);
    if (active) {
      throw errors.conflict('a montage for today is already in progress', {
        montageId: active.id,
        status: active.status,
      });
    }

    const [row] = await db
      .insert(montages)
      .values({
        userId: me.id,
        dayBucket,
        status: 'generating',
        theme: body.theme,
        musicId: body.musicId,
        sourceMediaIds: selectedMediaIds,
      })
      .returning();
    if (!row) throw errors.internal('failed to create montage');

    const renderJobId = await enqueueRenderMontage({ montageId: row.id });
    await db
      .update(montages)
      .set({ renderJobId })
      .where(eq(montages.id, row.id));

    reply.code(202);
    return montageGeneratingResponseSchema.parse({
      montageId: row.id,
      status: 'generating',
    });
  });

  /* -------------------------------- GET /montages/:id ----------------------- */
  // Owner-only status poll (§7.3). Drives the 2.4 generating poll + 2.5 review.
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const row = await loadOwnedOr404(id, me.id);

    // Expired/deleted/removed montages are GONE → 404 (no content, §6).
    if (
      row.status === 'expired' ||
      row.status === 'deleted_by_user' ||
      row.status === 'removed_by_admin'
    ) {
      throw errors.notFound('montage not found');
    }

    reply.code(200);
    return toMontageResponse(row);
  });

  /* -------------------------- GET /montages/:id/download-url ---------------- */
  // OWNER-ONLY signed GET for the rendered montage MP4 (§11.10 save-to-gallery /
  // Q7). A non-owner (or missing) montage → 404 (owner-scoped, no existence leak).
  // Serves the PUBLISHED (or reviewable draft_ready) render; expired/deleted/
  // not-yet-rendered → 404. TTL clamped to the montage's remaining lifetime so a
  // leaked URL 404s once the montage expires/purges (§6/§11).
  app.get('/:id/download-url', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const row = await loadOwnedOr404(id, me.id);

    // Gone / terminal → 404 (no content, §6).
    if (
      row.status === 'expired' ||
      row.status === 'deleted_by_user' ||
      row.status === 'removed_by_admin'
    ) {
      throw errors.notFound('montage not found');
    }
    // Must be rendered to have bytes to download (draft_ready or published).
    if (
      (row.status !== 'published' && row.status !== 'draft_ready') ||
      !row.videoPath
    ) {
      throw errors.notFound('montage not available for download');
    }

    const { url, expiresIn } = await presignGet(buckets.montages, row.videoPath, {
      expiryAt: montageExpiry(row),
    });

    reply.code(200);
    return downloadUrlResponseSchema.parse({ downloadUrl: url, expiresIn });
  });

  /* ---------------------------- POST /montages/:id/regenerate --------------- */
  // Owner-only; only while draft_ready or failed. Optionally new theme/music; reset
  // to generating + re-enqueue the render. Published montages can't be regenerated
  // (use replace); a still-generating one is rejected (already in flight).
  app.post('/:id/regenerate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const body = regenerateMontageRequestSchema.parse(req.body);
    if (body.musicId) assertKnownMusic(body.musicId);

    // Render-storm guard: cap render triggers per user BEFORE any work or enqueue.
    await throttleRenderTrigger({ userId: me.id });

    const row = await loadOwnedOr404(id, me.id);

    if (row.status !== 'draft_ready' && row.status !== 'failed') {
      throw errors.conflict('montage cannot be regenerated in its current state', {
        status: row.status,
      });
    }

    // If the caller re-picks a selection, re-validate it (own/valid/today/live) and
    // persist the new set; otherwise the existing persisted selection is reused as-is
    // so a regenerate stays consistent with what was originally chosen.
    const newSelection = body.mediaIds
      ? await resolveSelectedMedia(me.id, row.dayBucket, body.mediaIds)
      : undefined;

    // Conditional reset: only flip a row that's still draft_ready/failed (guards a
    // concurrent publish from racing the regenerate). The predicate means exactly
    // one regenerate wins; the loser sees the new state and 409s on its own read.
    const [updated] = await db
      .update(montages)
      .set({
        status: 'generating',
        ...(body.theme ? { theme: body.theme } : {}),
        ...(body.musicId ? { musicId: body.musicId } : {}),
        ...(newSelection ? { sourceMediaIds: newSelection } : {}),
        // Clear stale render outputs so a failed/old draft can't be served mid-render.
        videoPath: null,
        thumbnailPath: null,
        durationMs: null,
        edl: null,
        renderError: null,
      })
      .where(
        and(
          eq(montages.id, row.id),
          inArray(montages.status, ['draft_ready', 'failed']),
        ),
      )
      .returning();
    if (!updated) {
      // Lost the race — re-read + report the current (non-regenerable) state.
      const current = await loadOwnedOr404(id, me.id);
      throw errors.conflict('montage cannot be regenerated in its current state', {
        status: current.status,
      });
    }

    const renderJobId = await enqueueRenderMontage({ montageId: updated.id });
    await db
      .update(montages)
      .set({ renderJobId })
      .where(eq(montages.id, updated.id));

    reply.code(202);
    return montageGeneratingResponseSchema.parse({
      montageId: updated.id,
      status: 'generating',
    });
  });

  /* ------------------------------ POST /montages/:id/publish ---------------- */
  // Owner-only multi-group publish (Q1: one render → many groups). IDEMPOTENT: an
  // Idempotency-Key header dedupes; absent one, a NATURAL key (montage + sorted
  // group set) makes a re-publish to the SAME groups a no-op replay. Sets
  // published_at/expiry_at(+24h), inserts visibility rows, and enqueues the delayed
  // expire-montage(+24h) + cleanup-raw(+60min) jobs (consumers are Slice 7).
  app.post('/:id/publish', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const body = publishMontageRequestSchema.parse(req.body);

    const row = await loadOwnedOr404(id, me.id);

    // Must be reviewable (draft_ready) OR already published (idempotent re-publish).
    if (row.status !== 'draft_ready' && row.status !== 'published') {
      throw errors.conflict('montage is not ready to publish', { status: row.status });
    }

    // Authz: the caller MUST be an active member of EVERY target group. A single
    // non-member group rejects the whole publish (no partial visibility). Dedupe
    // the group set so a caller can't smuggle duplicates past the count.
    const groupIds = [...new Set(body.groupIds)];
    for (const gid of groupIds) {
      await assertMemberOf(gid, me.id); // throws 403 if not an active member
    }

    // Natural idempotency key: montage + the sorted group set. A re-publish to the
    // exact same set replays; a DIFFERENT set with the same Idempotency-Key conflicts.
    const sortedGroups = [...groupIds].sort();
    const naturalKey =
      (req.headers['idempotency-key'] as string | undefined) ??
      `publish:${row.id}:${hashBody(sortedGroups)}`;

    const result = await withIdempotency<MontageResponse>(
      {
        userId: me.id,
        endpoint: 'POST /montages/{id}/publish',
        key: naturalKey,
        body: { montageId: row.id, groupIds: sortedGroups },
      },
      async () => {
        const published = await publishMontageTx(row, sortedGroups);
        return { status: 200, body: await toMontageResponse(published) };
      },
    );

    reply.code(result.status);
    return result.body;
  });

  /* ------------------------------ POST /montages/:id/replace ---------------- */
  // Owner-only (Q2). The path id is the PRIOR montage; the body carries the
  // freshly-generated REPLACEMENT (draft_ready) + the groups it should be visible
  // to. We publish the replacement (visibility + expiry) and mark the prior montage
  // SUPERSEDED (status=deleted_by_user, superseded_by=replacement). Full cascade
  // delete of the prior render + its social is Slice 7 (here we mark + enqueue).
  app.post('/:id/replace', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const body = replaceMontageRequestSchema.parse(req.body);

    // Render-storm guard: replace publishes a fresh render, so it's a render-
    // triggering action — cap it per user too (BEFORE the publish work / enqueues).
    await throttleRenderTrigger({ userId: me.id });

    const prior = await loadOwnedOr404(id, me.id);
    const replacement = await loadOwnedOr404(body.replacementMontageId, me.id);

    if (replacement.id === prior.id) {
      throw errors.validation('replacement must be a different montage', {
        montageId: id,
      });
    }
    if (replacement.dayBucket !== prior.dayBucket) {
      throw errors.validation('replacement must be for the same day', {
        priorDay: prior.dayBucket,
        replacementDay: replacement.dayBucket,
      });
    }
    // The replacement must be a FRESH, reviewed-but-unpublished render (draft_ready),
    // not an already-published montage. Accepting a published replacement would
    // re-publish live content (resetting visibility/clocks) and muddy "which render is
    // live" — reject it so replace only ever promotes a draft into the prior's slot.
    if (replacement.status !== 'draft_ready') {
      throw errors.conflict('replacement montage must be a draft ready to publish', {
        status: replacement.status,
      });
    }

    const groupIds = [...new Set(body.groupIds)];
    for (const gid of groupIds) {
      await assertMemberOf(gid, me.id);
    }

    const sortedGroups = [...groupIds].sort();
    const naturalKey =
      (req.headers['idempotency-key'] as string | undefined) ??
      `replace:${prior.id}:${replacement.id}:${hashBody(sortedGroups)}`;

    const result = await withIdempotency<MontageResponse>(
      {
        userId: me.id,
        endpoint: 'POST /montages/{id}/replace',
        key: naturalKey,
        body: {
          priorId: prior.id,
          replacementId: replacement.id,
          groupIds: sortedGroups,
        },
      },
      async () => {
        // Publish the replacement (same path as publish), then supersede the prior.
        const published = await publishMontageTx(replacement, sortedGroups);
        // Mark the prior superseded (only if not already terminal). The prior's
        // content is HARD-DELETED by the supersede-cleanup worker job enqueued below
        // (S3 video+thumb + row + cascade reactions/comments/visibility + tombstone).
        await db
          .update(montages)
          .set({ status: 'deleted_by_user', supersededBy: published.id })
          .where(
            and(
              eq(montages.id, prior.id),
              ne(montages.status, 'deleted_by_user'),
            ),
          );
        // If the prior was already PUBLISHED, it has a pending +24h expire-montage
        // job that would fire on a montage that's now superseded (an orphan). Remove
        // it so expiry can't act on dead content. (cleanup-raw is keyed per user+day,
        // not per montage — leave it; the day's raw is purged by cleanup-raw/day-close.)
        if (prior.status === 'published') {
          await removeExpireMontage(prior.id);
        }
        // §6 Q2 REPLACE CASCADE: hard-delete the prior render's content now that the
        // replacement is live. Idempotency-guarded jobId + idempotent consumer, so a
        // publish replay can't double-delete and a redelivery is safe.
        await enqueueSupersedeCleanup({
          priorMontageId: prior.id,
          replacementId: published.id,
        });
        return { status: 200, body: await toMontageResponse(published) };
      },
    );

    reply.code(result.status);
    return result.body;
  });
};

/**
 * Publish a montage to `groupIds` in one transaction: set published_at/expiry_at,
 * (re-)insert visibility rows (idempotent on the composite PK), and enqueue the
 * delayed lifecycle jobs. Returns the updated row.
 *
 * Re-publishing an already-published montage REUSES its published_at/expiry_at (so
 * the 24h clock isn't reset on a replay) and only ADDS any new visibility rows —
 * making a re-publish to a superset of groups additive + safe.
 */
async function publishMontageTx(
  row: Montage,
  groupIds: string[],
): Promise<Montage> {
  const now = new Date();
  const lifetimeMs = env.MONTAGE_LIFETIME_HOURS * 3600 * 1000;

  const published = await db.transaction(async (tx) => {
    // Re-read the LIVE row inside the tx (the passed `row` may be a pre-publish
    // snapshot from before a prior, partially-applied publish). Preserve the
    // original publish instant on a re-publish so the 24h clock isn't reset.
    const [live] = await tx
      .select()
      .from(montages)
      .where(eq(montages.id, row.id))
      .limit(1);
    const publishedAt = live?.publishedAt ?? now;
    const expiryAt = live?.expiryAt ?? new Date(publishedAt.getTime() + lifetimeMs);

    const [updated] = await tx
      .update(montages)
      .set({ status: 'published', publishedAt, expiryAt })
      .where(eq(montages.id, row.id))
      .returning();

    // One render → many groups. ON CONFLICT DO NOTHING so a re-publish (or a
    // duplicate group) is idempotent on the composite PK.
    await tx
      .insert(montageGroupVisibility)
      .values(groupIds.map((groupId) => ({ montageId: row.id, groupId })))
      .onConflictDoNothing();

    // RAW LIFECYCLE (§6 Q5 / Fix 2a): stamp this day's raw `daily_media_item` rows
    // with `expiry_at = published_at + grace` so the raw-purge-sweep backstop (and
    // the `daily_media_item_expiry_idx`) can reclaim them even if the delayed
    // `cleanup-raw` job (publish+60min) is lost. Set ONLY where not already stamped
    // so a re-publish doesn't push the grace window forward. The published montage's
    // OWN video lives in the montages bucket (no expiry_at here), so it's untouched.
    const rawExpiry = new Date(publishedAt.getTime() + env.RAW_PURGE_GRACE_MINUTES * 60 * 1000);
    await tx
      .update(dailyMediaItems)
      .set({ expiryAt: rawExpiry })
      .where(
        and(
          eq(dailyMediaItems.userId, row.userId),
          eq(dailyMediaItems.dayBucket, row.dayBucket),
          sql`${dailyMediaItems.expiryAt} is null`,
        ),
      );

    return updated!;
  });

  // Schedule the §6 lifecycle jobs (consumers are Slice 7). Delays are relative to
  // the published row's expiry/grace so a re-publish replay doesn't shorten them.
  const expireDelayMs = Math.max(0, published.expiryAt!.getTime() - Date.now());
  await enqueueExpireMontage(
    { montageId: published.id, expiryAt: published.expiryAt!.toISOString() },
    expireDelayMs,
  );
  await enqueueCleanupRaw(
    { userId: published.userId, dayBucket: published.dayBucket, montageId: published.id },
    env.RAW_PURGE_GRACE_MINUTES * 60 * 1000,
  );

  return published;
}
