// Feed + social routes (M8 §5). All require a valid session (requireSession).
//
// No-leak is the highest-risk surface here: a montage that is blocked / expired /
// hidden / missing MUST all return the IDENTICAL 404 on reactions + comments — so
// those routes gate on requireCanView (canViewMontage → null → 404) and never branch.
// Block filtering is SYMMETRIC (the §10 learning): the both-direction notBlockedBetween
// fragment is applied to feed visibility, the comment list, the comment preview, AND
// the comment count. A malformed cursor is wrapped → 422 (VALIDATION), never a 500.
// Signed playback/thumbnail URL TTLs are capped at the recap's remaining lifetime
// (the §8.4 / M7 toMontageDto rule) so a leaked feed URL dies with the content.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CannotReactToOwnError,
  CommentNotFoundError,
  ForbiddenError,
  NotAMemberError,
  ValidationError,
  FEED_PAGE_SIZE,
  addCommentReqSchema,
  addCommentResSchema,
  commentsPageSchema,
  decodeCommentsCursor,
  decodeFeedCursor,
  encodeCommentsCursor,
  encodeFeedCursor,
  feedPageSchema,
  reactionSummarySchema,
  setReactionReqSchema,
  type CommentDTO,
  type FeedCard,
  type ReactionSummary,
  type ReactionType,
} from "@twenty4/contracts";
import { comment, montage, reaction, user } from "@twenty4/contracts/db";
import { presignMontageGet, presignThumbGet, type S3Deps } from "../media/s3.ts";
import { activeMembership } from "../groups/authz.ts";
import { montageVisibleTo, notBlockedBetween, requireCanView } from "./authz.ts";
import type { SocialRateLimiter } from "./socialRateLimit.ts";
import type { DbClient } from "../db.ts";
import type { makeRequireSession } from "../auth/guards.ts";

export interface FeedRoutesDeps {
  db: DbClient;
  requireSession: ReturnType<typeof makeRequireSession>;
  s3: S3Deps;
  rateLimiter: SocialRateLimiter;
  // Max comment length (env COMMENT_MAX_LENGTH) — enforced at the route, NOT in the
  // zod body schema, so CI can set a low cap deterministically.
  commentMaxLength: number;
}

// A signed-URL TTL capped at min(downloadTtl, remaining content lifetime) — a leaked
// feed URL must not outlive the recap (M7 §8.4). At least 1s so getSignedUrl is valid.
function contentTtl(s3: S3Deps, expiryAt: Date): number {
  const remaining = Math.floor((expiryAt.getTime() - Date.now()) / 1000);
  return Math.max(1, Math.min(s3.downloadTtlSec, remaining));
}

// A montage page row (joined to its author) as fetched by the feed keyset query.
interface FeedMontageRow {
  id: string;
  userId: string;
  dayBucket: string;
  durationMs: number | null;
  videoPath: string | null;
  thumbnailPath: string | null;
  publishedAt: Date | null;
  expiryAt: Date | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
}

// A comment row joined to its author (list + preview).
interface CommentRow {
  id: string;
  montageId: string;
  text: string;
  createdAt: Date;
  userId: string;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
}

function toCommentDto(r: CommentRow, viewerId: string): CommentDTO {
  return {
    id: r.id,
    montageId: r.montageId,
    author: { id: r.userId, displayName: r.authorDisplayName, avatarUrl: r.authorAvatarUrl },
    text: r.text,
    createdAt: r.createdAt.toISOString(),
    canDelete: r.userId === viewerId,
  };
}

export async function registerFeedRoutes(app: FastifyInstance, deps: FeedRoutesDeps): Promise<void> {
  const { db, requireSession, s3, rateLimiter, commentMaxLength } = deps;

  // The montage's TOTAL reaction count (NOT block-filtered — §7) + the caller's own
  // current reaction type (or null). Two cheap reads; correctness over cleverness.
  async function reactionSummaryFor(montageId: string, viewerId: string): Promise<ReactionSummary> {
    const counted = await db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(reaction)
      .where(eq(reaction.montageId, montageId));
    const mine = await db.db
      .select({ type: reaction.type })
      .from(reaction)
      .where(and(eq(reaction.montageId, montageId), eq(reaction.userId, viewerId)))
      .limit(1);
    return { count: counted[0]?.count ?? 0, viewerReaction: (mine[0]?.type as ReactionType) ?? null };
  }

  // The montage's ACTIVE comment count, block-filtered in BOTH directions vs caller.
  async function commentCountFor(montageId: string, viewerId: string): Promise<number> {
    const counted = await db.db
      .select({ count: sql<number>`count(*)::int` })
      .from(comment)
      .where(
        and(
          eq(comment.montageId, montageId),
          eq(comment.status, "active"),
          notBlockedBetween(viewerId, comment.userId),
        ),
      );
    return counted[0]?.count ?? 0;
  }

  // ── GET /feed?group=&cursor= ────────────────────────────────────────────────
  // Keyset page (10/page) of published, unexpired, member-visible, block-clean
  // recaps — INCLUDING the caller's own (no self-exclusion; §7 requires A sees A's
  // card with its counts). Optional `group` scopes to one group the caller is in
  // (else 403). A malformed cursor → 422, never 500.
  app.get("/feed", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const u = req.user!;
    const q = req.query as { group?: string; cursor?: string };

    // Optional single-group filter — must be a uuid (else 422) AND a group the
    // caller actively belongs to (else 403 via the shared membership gate).
    let groupId: string | undefined;
    if (q.group !== undefined) {
      groupId = z.string().uuid().parse(q.group);
      const m = await activeMembership(db, groupId, u.id);
      if (!m) throw new NotAMemberError();
    }

    // Opaque keyset cursor — decode inside try/catch so any garbage maps to 422.
    let cursor: { publishedAt: string; id: string } | undefined;
    if (q.cursor !== undefined && q.cursor !== "") {
      try {
        cursor = decodeFeedCursor(q.cursor);
      } catch {
        throw new ValidationError("Malformed cursor");
      }
    }

    const rows = (await db.db
      .select({
        id: montage.id,
        userId: montage.userId,
        dayBucket: montage.dayBucket,
        durationMs: montage.durationMs,
        videoPath: montage.videoPath,
        thumbnailPath: montage.thumbnailPath,
        publishedAt: montage.publishedAt,
        expiryAt: montage.expiryAt,
        authorDisplayName: user.displayName,
        authorAvatarUrl: user.profilePhotoUrl,
      })
      .from(montage)
      .innerJoin(user, eq(user.id, montage.userId))
      .where(
        and(
          eq(montage.status, "published"),
          sql`${montage.expiryAt} > now()`,
          montageVisibleTo(u.id, groupId),
          notBlockedBetween(u.id, montage.userId),
          // Keyset seek on (published_at DESC, id DESC): rows strictly AFTER the
          // cursor tuple. Row-value comparison handles the lexicographic order.
          cursor
            ? sql`(${montage.publishedAt}, ${montage.id}) < (${cursor.publishedAt}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(montage.publishedAt), desc(montage.id))
      .limit(FEED_PAGE_SIZE + 1)) as FeedMontageRow[];

    // n+1 fetch → compute nextCursor + drop the extra row.
    const page = rows.slice(0, FEED_PAGE_SIZE);
    let nextCursor: string | null = null;
    if (rows.length > FEED_PAGE_SIZE) {
      const last = page[page.length - 1]!;
      nextCursor = encodeFeedCursor({ publishedAt: last.publishedAt!.toISOString(), id: last.id });
    }

    const items: FeedCard[] = [];
    for (const m of page) {
      const ttl = m.expiryAt ? contentTtl(s3, m.expiryAt) : s3.downloadTtlSec;
      const videoUrl = m.videoPath ? await presignMontageGet(s3, m.videoPath, ttl) : null;
      const thumbnailUrl = m.thumbnailPath ? await presignThumbGet(s3, m.thumbnailPath, ttl) : null;

      const { count: reactionCount, viewerReaction } = await reactionSummaryFor(m.id, u.id);
      const commentCount = await commentCountFor(m.id, u.id);

      // Latest 2 active, block-clean comments (§11 preview depth). Fetch DESC then
      // reverse to ascending so the card shows them oldest→newest of the two.
      const previewRows = (await db.db
        .select({
          id: comment.id,
          montageId: comment.montageId,
          text: comment.text,
          createdAt: comment.createdAt,
          userId: comment.userId,
          authorDisplayName: user.displayName,
          authorAvatarUrl: user.profilePhotoUrl,
        })
        .from(comment)
        .innerJoin(user, eq(user.id, comment.userId))
        .where(
          and(
            eq(comment.montageId, m.id),
            eq(comment.status, "active"),
            notBlockedBetween(u.id, comment.userId),
          ),
        )
        .orderBy(desc(comment.createdAt), desc(comment.id))
        .limit(2)) as CommentRow[];
      const commentPreview = previewRows.reverse().map((r) => toCommentDto(r, u.id));

      items.push({
        montageId: m.id,
        author: { id: m.userId, displayName: m.authorDisplayName, avatarUrl: m.authorAvatarUrl },
        dayBucket: String(m.dayBucket),
        expiryAt: m.expiryAt!.toISOString(),
        durationMs: m.durationMs ?? null,
        videoUrl,
        thumbnailUrl,
        reactionCount,
        viewerReaction,
        commentCount,
        commentPreview,
        canDelete: m.userId === u.id,
        canReport: m.userId !== u.id,
        canReact: m.userId !== u.id, // owner only SEES the counts; cannot react (M9)
      });
    }

    reply.status(200).send(feedPageSchema.parse({ items, nextCursor }));
  });

  // ── POST /montages/:id/reactions ────────────────────────────────────────────
  // Upsert the caller's ONE reaction (replaceable type). Returns the live count +
  // the caller's type. Order: validate the body FIRST (a 422 on a bad type must not
  // burn a rate-limit token), then the canViewMontage gate (→404), then the rate-
  // limit check — requireCanView stays BEFORE the rate-limit so a 429-vs-404 can't
  // probe a hidden/missing montage's existence (no-leak preserved).
  app.post(
    "/montages/:id/reactions",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      const body = setReactionReqSchema.parse(req.body);
      const m = await requireCanView(db, u.id, id);
      // An owner only SEES their recap's reaction counts — they cannot react to it
      // (M9 polish). Gated AFTER requireCanView (the owner can view their own, so no
      // existence leak) and BEFORE the rate-limit (a guaranteed 403 burns no token).
      if (m.userId === u.id) throw new CannotReactToOwnError();
      await rateLimiter.checkReaction(u.id);

      await db.db
        .insert(reaction)
        .values({ montageId: id, userId: u.id, type: body.type })
        .onConflictDoUpdate({
          target: [reaction.montageId, reaction.userId],
          set: { type: body.type, createdAt: sql`now()` },
        });

      reply.status(200).send(reactionSummarySchema.parse(await reactionSummaryFor(id, u.id)));
    },
  );

  // ── DELETE /montages/:id/reactions ──────────────────────────────────────────
  // Remove the caller's reaction (idempotent — fine if none). Same canViewMontage
  // 404 gate. Returns the live count with viewerReaction null.
  app.delete(
    "/montages/:id/reactions",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      const m = await requireCanView(db, u.id, id);
      // Symmetric with POST: an owner has no reaction to clear (they can't set one) —
      // 403 consistently rather than a silent no-op.
      if (m.userId === u.id) throw new CannotReactToOwnError();
      await rateLimiter.checkReaction(u.id);

      await db.db.delete(reaction).where(and(eq(reaction.montageId, id), eq(reaction.userId, u.id)));

      const { count } = await reactionSummaryFor(id, u.id);
      reply.status(200).send(reactionSummarySchema.parse({ count, viewerReaction: null }));
    },
  );

  // ── GET /montages/:id/comments?cursor= ──────────────────────────────────────
  // List active, block-filtered (both directions) comments; keyset (created_at ASC,
  // id ASC). canViewMontage 404 gate; malformed cursor → 422.
  app.get(
    "/montages/:id/comments",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      await requireCanView(db, u.id, id);

      const q = req.query as { cursor?: string };
      let cursor: { createdAt: string; id: string } | undefined;
      if (q.cursor !== undefined && q.cursor !== "") {
        try {
          cursor = decodeCommentsCursor(q.cursor);
        } catch {
          throw new ValidationError("Malformed cursor");
        }
      }

      const rows = (await db.db
        .select({
          id: comment.id,
          montageId: comment.montageId,
          text: comment.text,
          createdAt: comment.createdAt,
          userId: comment.userId,
          authorDisplayName: user.displayName,
          authorAvatarUrl: user.profilePhotoUrl,
        })
        .from(comment)
        .innerJoin(user, eq(user.id, comment.userId))
        .where(
          and(
            eq(comment.montageId, id),
            eq(comment.status, "active"),
            notBlockedBetween(u.id, comment.userId),
            cursor
              ? sql`(${comment.createdAt}, ${comment.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(comment.createdAt), asc(comment.id))
        .limit(FEED_PAGE_SIZE + 1)) as CommentRow[];

      const pageRows = rows.slice(0, FEED_PAGE_SIZE);
      let nextCursor: string | null = null;
      if (rows.length > FEED_PAGE_SIZE) {
        const last = pageRows[pageRows.length - 1]!;
        nextCursor = encodeCommentsCursor({ createdAt: last.createdAt.toISOString(), id: last.id });
      }

      const items = pageRows.map((r) => toCommentDto(r, u.id));
      reply.status(200).send(commentsPageSchema.parse({ items, nextCursor }));
    },
  );

  // ── POST /montages/:id/comments ─────────────────────────────────────────────
  // Add a comment (rate-limited). Length cap enforced from env (NOT the schema).
  // Order: validate the body + length FIRST (a 422 on empty/over-length text must
  // not burn a rate-limit token), then the canViewMontage gate (→404), then the
  // rate-limit check — requireCanView stays BEFORE the rate-limit so a 429-vs-404
  // can't probe a hidden/missing montage's existence (no-leak preserved). Returns
  // the new comment + the live block-filtered count.
  app.post(
    "/montages/:id/comments",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      const body = addCommentReqSchema.parse(req.body);
      if (body.text.length > commentMaxLength) throw new ValidationError("Comment too long");
      await requireCanView(db, u.id, id);
      await rateLimiter.checkComment(u.id);

      const inserted = await db.db
        .insert(comment)
        .values({ montageId: id, userId: u.id, text: body.text, status: "active" })
        .returning();
      const row = inserted[0]!;

      const authorRows = await db.db
        .select({ displayName: user.displayName, avatarUrl: user.profilePhotoUrl })
        .from(user)
        .where(eq(user.id, u.id))
        .limit(1);
      const author = authorRows[0]!;

      const dto: CommentDTO = {
        id: row.id,
        montageId: row.montageId,
        author: { id: u.id, displayName: author.displayName, avatarUrl: author.avatarUrl },
        text: row.text,
        createdAt: row.createdAt.toISOString(),
        canDelete: true,
      };
      const commentCount = await commentCountFor(id, u.id);
      reply.status(201).send(addCommentResSchema.parse({ comment: dto, commentCount }));
    },
  );

  // ── DELETE /comments/:id ────────────────────────────────────────────────────
  // Soft-delete (status='deleted') the caller's OWN comment only. Missing OR already
  // deleted → 404; not-owned → 403. Owning the comment is sufficient (no montage
  // visibility gate), but the row carries the montageId we re-count against.
  app.delete(
    "/comments/:id",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;

      const rows = await db.db.select().from(comment).where(eq(comment.id, id)).limit(1);
      const row = rows[0];
      if (!row || row.status === "deleted") throw new CommentNotFoundError();
      if (row.userId !== u.id) throw new ForbiddenError("You can only delete your own comment");

      await db.db.update(comment).set({ status: "deleted" }).where(eq(comment.id, id));

      const commentCount = await commentCountFor(row.montageId, u.id);
      reply.status(200).send({ commentCount });
    },
  );
}
