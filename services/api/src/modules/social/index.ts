/**
 * social module (§8 Feed & social; PLAN §3 + §6 Slice 6).
 *
 * Mounted at `/montages` (alongside the montage module — the two own disjoint
 * paths). Owns the social + owner-delete surface for a PUBLISHED montage:
 *
 *   POST   /montages/:id/reactions   {type}  upsert the caller's ONE reaction
 *   DELETE /montages/:id/reactions            remove the caller's reaction
 *   GET    /montages/:id/comments             cursor-paginated, active comments
 *   POST   /montages/:id/comments    {text}   add a comment (length-bounded)
 *   DELETE /montages/:id             owner-only hard-delete (cascade + S3)
 *
 * `DELETE /comments/:commentId` lives in the sibling `commentsModule` (root path).
 *
 * AUTHZ — every social action is gated by `canViewMontage` (caller shares an
 * ACTIVE group with the montage AND no block in either direction; the montage is
 * published + not expired). A montage the caller cannot view → 404 (NOT 403): a
 * non-member or blocked user can't distinguish "exists but hidden" from "gone",
 * so there is no existence leak for ephemeral content (§6/§11). The owner-delete
 * path uses owner-scoping (a non-owner → 404) rather than viewer-gating.
 */
import type { FastifyPluginAsync } from 'fastify';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import {
  comments,
  montages,
  reactions,
  users,
  type Montage,
} from '@twenty4/contracts/db';
import { REACTION_TYPES, type ReactionType } from '@twenty4/contracts/enums';
import {
  upsertReactionRequestSchema,
  reactionResponseSchema,
  reactionSummarySchema,
  createCommentRequestSchema,
  commentsQuerySchema,
  commentResponseSchema,
  commentsResponseSchema,
  type ReactionSummary,
  type CommentResponse,
} from '@twenty4/contracts/dto';
import { errors } from '@twenty4/contracts/errors';

import { requireSession } from '../../auth/middleware.js';
import { canViewMontage } from '../../authz/montageVisibility.js';
import { db } from '../../db/index.js';
import { buckets, deleteObject } from '../../storage/s3.js';
import { throttleReaction, throttleComment } from '../../lib/rateLimit.js';

/** Cheap uuid shape guard so a malformed :id 404s instead of erroring on the cast. */
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Build the reaction summary (counts by type + total + the caller's own) for one montage. */
export async function buildReactionSummary(
  montageId: string,
  userId: string,
): Promise<ReactionSummary> {
  const counts = Object.fromEntries(REACTION_TYPES.map((t) => [t, 0])) as Record<
    ReactionType,
    number
  >;
  const agg = await db
    .select({ type: reactions.type, n: sql<number>`count(*)::int` })
    .from(reactions)
    .where(eq(reactions.montageId, montageId))
    .groupBy(reactions.type);
  let total = 0;
  for (const r of agg) {
    counts[r.type as ReactionType] = r.n;
    total += r.n;
  }
  const [mine] = await db
    .select({ type: reactions.type })
    .from(reactions)
    .where(and(eq(reactions.montageId, montageId), eq(reactions.userId, userId)))
    .limit(1);
  return reactionSummarySchema.parse({
    counts,
    total,
    mine: mine?.type ?? null,
  });
}

/** Gate a social action on viewability; 404 (no existence leak) when not visible. */
async function requireViewable(montageId: string, userId: string): Promise<Montage> {
  if (!isUuid(montageId)) throw errors.notFound('montage not found');
  const visible = await canViewMontage(montageId, userId);
  if (!visible) throw errors.notFound('montage not found');
  return visible.montage;
}

/** A comment row joined to its author for the list/create response. */
async function toCommentResponse(row: {
  id: string;
  montageId: string;
  userId: string;
  text: string;
  createdAt: Date;
}): Promise<CommentResponse> {
  const [author] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      username: users.username,
      profilePhotoUrl: users.profilePhotoUrl,
    })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  return commentResponseSchema.parse({
    id: row.id,
    montageId: row.montageId,
    author: {
      id: row.userId,
      displayName: author?.displayName ?? '',
      username: author?.username ?? '',
      profilePhotoUrl: isHttpUrl(author?.profilePhotoUrl) ? author!.profilePhotoUrl : null,
    },
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  });
}

export const socialModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireSession);

  /* --------------------- POST /montages/:id/reactions ----------------------- */
  // Upsert the caller's ONE reaction (unique montage_id,user_id). Changing type
  // REPLACES (ON CONFLICT DO UPDATE). Gated by canViewMontage → 404 if not viewable.
  app.post('/:id/reactions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const body = upsertReactionRequestSchema.parse(req.body);

    await throttleReaction({ userId: me.id });
    await requireViewable(id, me.id);

    const [row] = await db
      .insert(reactions)
      .values({ montageId: id, userId: me.id, type: body.type })
      .onConflictDoUpdate({
        target: [reactions.montageId, reactions.userId],
        set: { type: body.type },
      })
      .returning();

    const summary = await buildReactionSummary(id, me.id);
    reply.code(200);
    return {
      reaction: reactionResponseSchema.parse({
        montageId: id,
        type: row!.type,
        createdAt: row!.createdAt.toISOString(),
      }),
      summary,
    };
  });

  /* -------------------- DELETE /montages/:id/reactions ---------------------- */
  // Remove the caller's reaction (idempotent — no-op if none). Returns the summary.
  app.delete('/:id/reactions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;

    await throttleReaction({ userId: me.id });
    await requireViewable(id, me.id);

    await db
      .delete(reactions)
      .where(and(eq(reactions.montageId, id), eq(reactions.userId, me.id)));

    const summary = await buildReactionSummary(id, me.id);
    reply.code(200);
    return { summary };
  });

  /* ---------------------- GET /montages/:id/comments ------------------------ */
  // Cursor-paginated ACTIVE comments, oldest-first (chronological reading order).
  // Keyset on (created_at ASC, id ASC). Gated by canViewMontage → 404.
  app.get('/:id/comments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    // Coerce the string query `limit` to a number for the (numeric, strict) DTO.
    const rawQuery = (req.query ?? {}) as Record<string, unknown>;
    const q = commentsQuerySchema.parse({
      ...rawQuery,
      limit:
        rawQuery.limit === undefined || rawQuery.limit === ''
          ? undefined
          : Number(rawQuery.limit),
    });
    const limit = q.limit ?? 20;

    await requireViewable(id, me.id);

    const cursor = q.cursor ? decodeCommentCursor(q.cursor) : null;
    const keyset = cursor
      ? or(
          sql`${comments.createdAt} > ${new Date(cursor.createdAt)}`,
          and(
            eq(comments.createdAt, new Date(cursor.createdAt)),
            sql`${comments.id} > ${cursor.id}`,
          ),
        )
      : undefined;

    const rows = await db
      .select({
        id: comments.id,
        montageId: comments.montageId,
        userId: comments.userId,
        text: comments.text,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .where(and(eq(comments.montageId, id), eq(comments.status, 'active'), keyset))
      .orderBy(asc(comments.createdAt), asc(comments.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = await Promise.all(page.map((r) => toCommentResponse(r)));
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCommentCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;

    reply.code(200);
    return commentsResponseSchema.parse({ items, nextCursor });
  });

  /* ---------------------- POST /montages/:id/comments ----------------------- */
  // Add a comment (length-bounded in the DTO; rate-limited). Gated → 404.
  app.post('/:id/comments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const body = createCommentRequestSchema.parse(req.body);

    await throttleComment({ userId: me.id });
    await requireViewable(id, me.id);

    const [row] = await db
      .insert(comments)
      .values({ montageId: id, userId: me.id, text: body.text, status: 'active' })
      .returning();

    reply.code(201);
    return toCommentResponse(row!);
  });

  /* ----------------------------- DELETE /montages/:id ----------------------- */
  // Owner-only hard-delete (pre-expiry). Hard-deletes the montage row, which
  // CASCADES its reactions + comments + visibility rows (FK ON DELETE CASCADE),
  // and deletes the video + thumbnail S3 objects (no orphans). A previously-issued
  // signed URL then 404s with the CONTENT, not merely hides it (§6/§11). A
  // non-owner (or missing) montage → 404 (owner-scoped, no existence leak).
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    if (!isUuid(id)) throw errors.notFound('montage not found');

    // Owner-scoped load (NOT viewer-gated): only the owner may delete. A non-owner
    // — even one who CAN view it — gets the same 404 as a missing row.
    const [row] = await db
      .select()
      .from(montages)
      .where(and(eq(montages.id, id), eq(montages.userId, me.id)))
      .limit(1);
    if (!row) throw errors.notFound('montage not found');

    // Already terminal (expired/deleted/removed) → gone (§6). 404, idempotent.
    if (
      row.status === 'expired' ||
      row.status === 'deleted_by_user' ||
      row.status === 'removed_by_admin'
    ) {
      throw errors.notFound('montage not found');
    }

    // Delete the S3 objects FIRST (best-effort; DELETE is idempotent on S3) so a
    // leaked signed URL can't outlive the row delete, then hard-delete the row
    // (cascades reactions + comments + montage_group_visibility).
    if (row.videoPath) await deleteObject(buckets.montages, row.videoPath);
    if (row.thumbnailPath) await deleteObject(buckets.thumbnails, row.thumbnailPath);
    await db.delete(montages).where(eq(montages.id, row.id));

    reply.code(204).send();
  });
};

/* -------------------------------------------------------------------------- */
/*  commentsModule — DELETE /comments/:commentId (root path per spec §8).       */
/* -------------------------------------------------------------------------- */

/**
 * Delete a comment. Allowed for the comment's AUTHOR or the MONTAGE OWNER (the
 * owner can remove any comment on their montage — moderation of their own card).
 * Anyone else → 403. A missing comment → 404. We additionally require the parent
 * montage be VIEWABLE by the caller (so a blocked/non-member can't act on it) —
 * EXCEPT the montage owner, who can always moderate their own montage's comments.
 *
 * Hard-deletes the row (it lives & dies with its montage, §6) rather than soft-
 * setting status, so the comment is truly gone.
 */
export const commentsModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireSession);

  app.delete('/:commentId', async (req, reply) => {
    const { commentId } = req.params as { commentId: string };
    const me = req.user!;
    if (!isUuid(commentId)) throw errors.notFound('comment not found');

    const [row] = await db
      .select({
        id: comments.id,
        montageId: comments.montageId,
        userId: comments.userId,
        montageOwnerId: montages.userId,
        montageStatus: montages.status,
      })
      .from(comments)
      .innerJoin(montages, eq(montages.id, comments.montageId))
      .where(eq(comments.id, commentId))
      .limit(1);
    if (!row) throw errors.notFound('comment not found');

    const isAuthor = row.userId === me.id;
    const isMontageOwner = row.montageOwnerId === me.id;

    // The montage owner can always moderate their own card's comments. For anyone
    // else, FIRST gate on viewability — a caller who can't even SEE the montage
    // (non-member or blocked, either direction) gets a 404 (no existence leak),
    // NOT a 403 that would confirm the comment exists. Then enforce authorship: a
    // viewer who is neither the author nor the owner → 403.
    if (!isMontageOwner) {
      const visible = await canViewMontage(row.montageId, me.id);
      if (!visible) throw errors.notFound('comment not found');
      if (!isAuthor) {
        throw errors.forbidden('not allowed to delete this comment');
      }
    }

    await db.delete(comments).where(eq(comments.id, row.id));
    reply.code(204).send();
  });
};

/* ------------------------------ comment cursor ----------------------------- */

interface CommentCursor {
  createdAt: string;
  id: string;
}

function encodeCommentCursor(c: CommentCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCommentCursor(raw: string): CommentCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as CommentCursor).createdAt === 'string' &&
      typeof (parsed as CommentCursor).id === 'string'
    ) {
      const c = parsed as CommentCursor;
      if (Number.isNaN(Date.parse(c.createdAt))) throw new Error('bad ts');
      return c;
    }
    throw new Error('shape');
  } catch {
    throw errors.validation('invalid cursor');
  }
}

/** True when `v` is a parseable absolute URL. */
function isHttpUrl(v: string | null | undefined): v is string {
  if (!v) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}
