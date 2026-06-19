/**
 * feed module (§8 Feed & social; PLAN §3 + §6 Slice 6 + §10).
 *
 * GET /feed — the caller's chronological feed of TODAY's published, non-expired
 * montages, CURSOR-paginated at 10/page (§10). The visibility rule (PLAN §3):
 *
 *   a montage appears iff it is `published` AND `expiry_at > now` AND it is
 *   published to ≥1 group the caller is an ACTIVE member of, MINUS any montage
 *   whose owner the caller has blocked OR who has blocked the caller (BOTH-
 *   direction block filter). A montage visible through multiple shared groups is
 *   DEDUPED to a single card.
 *
 * Ordering & cursor: (published_at DESC, id DESC) with an opaque base64 cursor
 * carrying the last card's (published_at, id) — a stable keyset so a montage is
 * never skipped or repeated across pages, and it never leaks a montage past its
 * expiry (the WHERE re-checks `expiry_at > now` every page).
 *
 * Each card carries: presigned video (montages bucket) + thumbnail (thumbnails
 * bucket) GETs clamped to the montage's REMAINING lifetime (a leaked URL 404s at
 * expiry, §6/§11), the owner summary, the caller's shared group ids, the reaction
 * summary (counts by type + the caller's own reaction), and the comment count.
 *
 * Efficiency (§10 feed p95 target): one keyset-paginated query selects the page of
 * montage ids (driven by the partial index on (status, expiry_at)); reactions,
 * comments, shared groups, and authors are then batch-loaded for just that page
 * (no N+1). The block filter is a NOT-IN on a small per-caller set.
 */
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import {
  comments,
  groupMembers,
  montageGroupVisibility,
  montages,
  reactions,
  users,
} from '@twenty4/contracts/db';
import { REACTION_TYPES, type ReactionType } from '@twenty4/contracts/enums';
import {
  feedQuerySchema,
  feedResponseSchema,
  type FeedCard,
  type ReactionSummary,
} from '@twenty4/contracts/dto';
import { errors } from '@twenty4/contracts/errors';

import { requireSession } from '../../auth/middleware.js';
import { assertMemberOf } from '../../authz/groupMembership.js';
import { blockedUserIds } from '../../authz/montageVisibility.js';
import { db } from '../../db/index.js';
import { buckets, presignGet } from '../../storage/s3.js';

/** Feed page size (§10: 10 cards/page). The query DTO already caps `limit` at 10. */
const FEED_PAGE_SIZE = 10;

/** uuid shape guard — a crafted cursor with a non-uuid id must 422, never reach the DB (500). */
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** A decoded keyset cursor — the (publishedAt, id) of the LAST card of a page. */
interface FeedCursor {
  publishedAt: string; // ISO
  id: string;
}

/** Encode a keyset cursor opaquely (base64url of the JSON tuple). */
function encodeCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Decode an opaque cursor; reject a malformed one with a 422 (never crash). */
function decodeCursor(raw: string): FeedCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as FeedCursor).publishedAt === 'string' &&
      typeof (parsed as FeedCursor).id === 'string'
    ) {
      const c = parsed as FeedCursor;
      if (Number.isNaN(Date.parse(c.publishedAt))) throw new Error('bad ts');
      // The id is interpolated into the keyset predicate (lt(montages.id, ...)); a
      // non-uuid would reach the DB and 500 on the uuid cast. Reject it as a 422.
      if (!isUuid(c.id)) throw new Error('bad id');
      return c;
    }
    throw new Error('shape');
  } catch {
    throw errors.validation('invalid cursor');
  }
}

/** Empty reaction summary (all types → 0). */
function emptyReactionSummary(): ReactionSummary {
  const counts = Object.fromEntries(REACTION_TYPES.map((t) => [t, 0])) as Record<
    ReactionType,
    number
  >;
  return { counts, total: 0, mine: null };
}

export const feedModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireSession);

  /* --------------------------------- GET /feed ------------------------------ */
  app.get('/', async (req, reply) => {
    const me = req.user!;
    // Query params arrive as strings; coerce `limit` to a number before validating
    // against the (numeric, strict) feed query DTO. An absent limit stays absent.
    const rawQuery = (req.query ?? {}) as Record<string, unknown>;
    const q = feedQuerySchema.parse({
      ...rawQuery,
      limit:
        rawQuery.limit === undefined || rawQuery.limit === ''
          ? undefined
          : Number(rawQuery.limit),
    });
    const limit = q.limit ?? FEED_PAGE_SIZE;
    const now = new Date();

    // Visibility scope: the caller's ACTIVE-member groups. Optionally narrowed to a
    // single group (?group=) — which must be one the caller is an active member of
    // (assertMemberOf → 403 otherwise; no feed for a group you're not in).
    let scopeGroupIds: string[];
    if (q.group) {
      await assertMemberOf(q.group, me.id);
      scopeGroupIds = [q.group];
    } else {
      const rows = await db
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .where(and(eq(groupMembers.userId, me.id), eq(groupMembers.status, 'active')));
      scopeGroupIds = [...new Set(rows.map((r) => r.groupId))];
    }

    // No groups ⇒ nothing visible (and `inArray(..., [])` is invalid SQL).
    if (scopeGroupIds.length === 0) {
      reply.code(200);
      return feedResponseSchema.parse({ items: [], nextCursor: null });
    }

    // Both-direction block filter: owners to EXCLUDE entirely.
    const excludeOwners = await blockedUserIds(me.id);

    // Keyset predicate: page after the cursor's (published_at, id) in
    // (published_at DESC, id DESC) order.
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const keyset = cursor
      ? or(
          lt(montages.publishedAt, new Date(cursor.publishedAt)),
          and(
            eq(montages.publishedAt, new Date(cursor.publishedAt)),
            lt(montages.id, cursor.id),
          ),
        )
      : undefined;

    // The page of DISTINCT montage ids visible to the caller. DISTINCT dedupes a
    // montage shared through multiple groups. Drives off the partial index
    // (status='published') + the visibility join; fetch limit+1 to know if there's
    // a next page. Block-excluded owners are removed via NOT IN.
    const pageRows = await db
      .selectDistinct({
        id: montages.id,
        publishedAt: montages.publishedAt,
      })
      .from(montages)
      .innerJoin(
        montageGroupVisibility,
        eq(montageGroupVisibility.montageId, montages.id),
      )
      .where(
        and(
          eq(montages.status, 'published'),
          gt(montages.expiryAt, now),
          inArray(montageGroupVisibility.groupId, scopeGroupIds),
          excludeOwners.length > 0
            ? sql`${montages.userId} not in (${sql.join(
                excludeOwners.map((id) => sql`${id}`),
                sql`, `,
              )})`
            : undefined,
          keyset,
        ),
      )
      .orderBy(desc(montages.publishedAt), desc(montages.id))
      .limit(limit + 1);

    const hasMore = pageRows.length > limit;
    const page = hasMore ? pageRows.slice(0, limit) : pageRows;

    if (page.length === 0) {
      reply.code(200);
      return feedResponseSchema.parse({ items: [], nextCursor: null });
    }

    const montageIds = page.map((r) => r.id);

    // Batch-load the full montage rows (for owner id + paths + clocks). Re-apply the
    // status='published' AND expiry_at>now guard EXPLICITLY (defensive, self-healing):
    // the page-id query already filtered on it, but if a montage expired or was
    // superseded between the two queries this reload must not resurrect it into a card
    // — a leaked-content guard that costs nothing on the already-narrow id set.
    const fullRows = await db
      .select()
      .from(montages)
      .where(
        and(
          inArray(montages.id, montageIds),
          eq(montages.status, 'published'),
          gt(montages.expiryAt, now),
        ),
      );
    const byId = new Map(fullRows.map((r) => [r.id, r]));

    // Batch-load authors.
    const authorIds = [...new Set(fullRows.map((r) => r.userId))];
    const authorRows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        profilePhotoUrl: users.profilePhotoUrl,
      })
      .from(users)
      .where(inArray(users.id, authorIds));
    const authorById = new Map(authorRows.map((r) => [r.id, r]));

    // Batch-load the caller's SHARED active groups per montage (only within scope).
    const sharedRows = await db
      .select({
        montageId: montageGroupVisibility.montageId,
        groupId: montageGroupVisibility.groupId,
      })
      .from(montageGroupVisibility)
      .innerJoin(
        groupMembers,
        and(
          eq(groupMembers.groupId, montageGroupVisibility.groupId),
          eq(groupMembers.userId, me.id),
          eq(groupMembers.status, 'active'),
        ),
      )
      .where(inArray(montageGroupVisibility.montageId, montageIds));
    const sharedByMontage = new Map<string, string[]>();
    for (const r of sharedRows) {
      const arr = sharedByMontage.get(r.montageId) ?? [];
      arr.push(r.groupId);
      sharedByMontage.set(r.montageId, arr);
    }

    // Batch-load reaction counts by (montage, type).
    const reactionAgg = await db
      .select({
        montageId: reactions.montageId,
        type: reactions.type,
        n: sql<number>`count(*)::int`,
      })
      .from(reactions)
      .where(inArray(reactions.montageId, montageIds))
      .groupBy(reactions.montageId, reactions.type);
    const reactionsByMontage = new Map<string, ReactionSummary>();
    for (const id of montageIds) reactionsByMontage.set(id, emptyReactionSummary());
    for (const r of reactionAgg) {
      const s = reactionsByMontage.get(r.montageId)!;
      s.counts[r.type as ReactionType] = r.n;
      s.total += r.n;
    }

    // The caller's OWN reaction per montage.
    const mineRows = await db
      .select({ montageId: reactions.montageId, type: reactions.type })
      .from(reactions)
      .where(and(inArray(reactions.montageId, montageIds), eq(reactions.userId, me.id)));
    for (const r of mineRows) {
      reactionsByMontage.get(r.montageId)!.mine = r.type as ReactionType;
    }

    // Batch-load comment counts (active only). Block integrity: exclude comments
    // authored by users the caller has blocked (either direction) — `excludeOwners`
    // is the same both-direction block set — so the card's count matches what the
    // viewer actually sees in GET /montages/:id/comments (which filters identically).
    const commentAgg = await db
      .select({ montageId: comments.montageId, n: sql<number>`count(*)::int` })
      .from(comments)
      .where(
        and(
          inArray(comments.montageId, montageIds),
          eq(comments.status, 'active'),
          excludeOwners.length > 0
            ? sql`${comments.userId} not in (${sql.join(
                excludeOwners.map((uid) => sql`${uid}`),
                sql`, `,
              )})`
            : undefined,
        ),
      )
      .groupBy(comments.montageId);
    const commentCountByMontage = new Map(commentAgg.map((r) => [r.montageId, r.n]));

    // Build cards IN PAGE ORDER (preserve the keyset ordering of `page`).
    const items: FeedCard[] = [];
    for (const p of page) {
      const row = byId.get(p.id);
      if (!row || !row.publishedAt || !row.expiryAt) continue;
      const author = authorById.get(row.userId);
      if (!author) continue;

      let videoUrl: string | null = null;
      let thumbnailUrl: string | null = null;
      if (row.videoPath) {
        videoUrl = (
          await presignGet(buckets.montages, row.videoPath, { expiryAt: row.expiryAt })
        ).url;
      }
      if (row.thumbnailPath) {
        thumbnailUrl = (
          await presignGet(buckets.thumbnails, row.thumbnailPath, {
            expiryAt: row.expiryAt,
          })
        ).url;
      }

      items.push({
        montageId: row.id,
        author: {
          id: author.id,
          displayName: author.displayName ?? '',
          username: author.username ?? '',
          profilePhotoUrl: isHttpUrl(author.profilePhotoUrl)
            ? author.profilePhotoUrl
            : null,
        },
        thumbnailUrl,
        videoUrl,
        durationMs: row.durationMs ?? null,
        publishedAt: row.publishedAt.toISOString(),
        expiryAt: row.expiryAt.toISOString(),
        groupIds: sharedByMontage.get(row.id) ?? [],
        reactions: reactionsByMontage.get(row.id) ?? emptyReactionSummary(),
        commentCount: commentCountByMontage.get(row.id) ?? 0,
      });
    }

    const last = page[page.length - 1]!;
    const nextCursor =
      hasMore && last.publishedAt
        ? encodeCursor({ publishedAt: last.publishedAt.toISOString(), id: last.id })
        : null;

    reply.code(200);
    return feedResponseSchema.parse({ items, nextCursor });
  });
};

/** True when `v` is a parseable absolute URL (gate stored profile photo values). */
function isHttpUrl(v: string | null | undefined): v is string {
  if (!v) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}
