/**
 * safety module (§8 Safety; PLAN §3 + §6 Slice 8) — report + block.
 *
 * Two plugins, both `requireSession`-gated:
 *
 *   reportsModule (mounted at /reports):
 *     POST /reports {targetType, targetId, reason, detail?}
 *       Create a report against a montage | comment | user. The caller must be
 *       able to SEE the target (a montage/comment is gated by `canViewMontage` —
 *       a non-member/blocked reporter gets a 404, no existence leak); a user
 *       target requires the user to exist + not be blocked either way. For a
 *       montage/comment a minimal CONTENT SNAPSHOT is captured for moderation and
 *       marked for §13 7-day cleanup. Rate-limited. DEDUP: a repeat OPEN report by
 *       the same reporter against the same target is a no-op (partial-unique index).
 *
 *   blocksModule (mounted at /blocks):
 *     POST   /blocks {userId}     Block a user (uniq blocker+blocked; can't self-block).
 *                                 Takes effect immediately — the feed + every social
 *                                 action already filter BOTH block directions (Slice 6
 *                                 authz/montageVisibility). Idempotent (re-block no-ops).
 *     DELETE /blocks/:userId      Unblock (idempotent).
 *     GET    /blocks              The caller's blocked-user list (with user summaries).
 *
 * Blocking is symmetric for visibility (the feed/social filter hides content in
 * EITHER direction). Per spec the block does not tear down group membership rows
 * (the user stays a member) — it only hides content; the existing both-direction
 * filter handles co-membership visibility, so no extra teardown is required here.
 */
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { blocks, comments, reports, users } from '@twenty4/contracts/db';
import {
  createReportRequestSchema,
  reportResponseSchema,
  createBlockRequestSchema,
  blockListResponseSchema,
} from '@twenty4/contracts/dto';
import { errors } from '@twenty4/contracts/errors';

import { requireSession } from '../../auth/middleware.js';
import {
  canViewMontage,
  blockExistsEitherWay,
} from '../../authz/montageVisibility.js';
import { db } from '../../db/index.js';
import { consumeFixedWindow } from '../../lib/rateLimit.js';
import { writeAuditTombstone } from '../../lib/audit.js';

/** Cheap uuid shape guard so a malformed id 404s rather than erroring on the cast. */
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Days a reported-content snapshot is retained before the §13 cleanup purges it. */
const SNAPSHOT_RETENTION_DAYS = 7;

/* --------------------------------- limits ---------------------------------- */

/**
 * Report cap (§8 "rate limits"). A report is a moderation signal; bound how fast a
 * user can file so report-spam / mass-flag abuse is throttled. Fails OPEN — the
 * dedup index already collapses repeat reports against one target, and reporting
 * is a legitimate safety action; the limiter only blunts bulk-flag bursts.
 */
const REPORT_BUCKET = 'safety:report:user';
const REPORT_MAX = 30; // per 10 min.
const REPORT_WINDOW = 600;

async function throttleReport(userId: string): Promise<void> {
  const res = await consumeFixedWindow({
    bucket: REPORT_BUCKET,
    subject: userId,
    max: REPORT_MAX,
    windowSeconds: REPORT_WINDOW,
    failClosed: false,
  });
  if (!res.allowed) {
    throw errors.rateLimited('too many reports; slow down', { retryAfter: res.retryAfter });
  }
}

/* -------------------------------------------------------------------------- */
/*  reportsModule — POST /reports                                              */
/* -------------------------------------------------------------------------- */

export const reportsModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireSession);

  app.post('/', async (req, reply) => {
    const me = req.user!;
    const body = createReportRequestSchema.parse(req.body);

    await throttleReport(me.id);

    // 1) Visibility gate + capture a minimal content snapshot per target type.
    //    A target the caller cannot SEE → 404 (no existence leak), same as social.
    let snapshot: Record<string, unknown> | null = null;

    if (body.targetType === 'montage') {
      const visible = await canViewMontage(body.targetId, me.id);
      if (!visible) throw errors.notFound('target not found');
      const m = visible.montage;
      // Minimal moderation snapshot — ids + non-content fields ONLY (no caption/
      // user text). Enough to locate the content for review within retention.
      snapshot = {
        montageId: m.id,
        ownerId: m.userId,
        dayBucket: m.dayBucket,
        videoPath: m.videoPath ?? null,
        thumbnailPath: m.thumbnailPath ?? null,
        status: m.status,
      };
    } else if (body.targetType === 'comment') {
      if (!isUuid(body.targetId)) throw errors.notFound('target not found');
      const [row] = await db
        .select({
          id: comments.id,
          montageId: comments.montageId,
          authorId: comments.userId,
          text: comments.text,
          status: comments.status,
        })
        .from(comments)
        .where(eq(comments.id, body.targetId))
        .limit(1);
      if (!row || row.status !== 'active') throw errors.notFound('target not found');
      // The comment's montage must be viewable by the reporter (else 404).
      const visible = await canViewMontage(row.montageId, me.id);
      if (!visible) throw errors.notFound('target not found');
      // For a comment, the reported TEXT is the content under review, so we DO
      // retain it (legally-appropriate moderation snapshot, §13) — stored ONLY in
      // the report's content_snapshot, purged after the retention window, never in
      // analytics or the audit log.
      snapshot = {
        commentId: row.id,
        montageId: row.montageId,
        authorId: row.authorId,
        text: row.text,
      };
    } else {
      // user target: the user must exist and not be blocked either direction.
      if (!isUuid(body.targetId)) throw errors.notFound('target not found');
      if (body.targetId === me.id) {
        throw errors.validation('cannot report yourself');
      }
      const [target] = await db
        .select({ id: users.id, accountStatus: users.accountStatus })
        .from(users)
        .where(eq(users.id, body.targetId))
        .limit(1);
      if (!target || target.accountStatus === 'deleted') {
        throw errors.notFound('target not found');
      }
      if (await blockExistsEitherWay(me.id, body.targetId)) {
        throw errors.notFound('target not found');
      }
      // No content snapshot for a user-level report (nothing ephemeral to retain).
      snapshot = null;
    }

    // 2) Insert the report. DEDUP: a still-OPEN report by this reporter against this
    //    target collides on the partial-unique index → DO NOTHING; we then return the
    //    EXISTING open report (idempotent create).
    const purgeAt =
      snapshot !== null
        ? new Date(Date.now() + SNAPSHOT_RETENTION_DAYS * 24 * 3600 * 1000)
        : null;

    const inserted = await db
      .insert(reports)
      .values({
        reporterId: me.id,
        targetType: body.targetType,
        targetId: body.targetId,
        reason: body.reason,
        detail: body.detail ?? null,
        status: 'open',
        contentSnapshot: snapshot,
        snapshotPurgeAt: purgeAt,
      })
      .onConflictDoNothing({
        target: [reports.reporterId, reports.targetType, reports.targetId],
        where: eq(reports.status, 'open'),
      })
      .returning();

    let report = inserted[0];
    let created = true;
    if (!report) {
      // Dedup hit — fetch the existing open report (idempotent response).
      created = false;
      const [existing] = await db
        .select()
        .from(reports)
        .where(
          and(
            eq(reports.reporterId, me.id),
            eq(reports.targetType, body.targetType),
            eq(reports.targetId, body.targetId),
            eq(reports.status, 'open'),
          ),
        )
        .limit(1);
      report = existing;
    }
    if (!report) throw errors.internal('failed to create report');

    // 3) Audit the report creation (content-free: ids + reason code + target type).
    if (created) {
      await writeAuditTombstone({
        actorId: me.id,
        action: 'report_created',
        targetType: 'report',
        targetId: report.id,
        metadata: {
          targetType: body.targetType,
          targetId: body.targetId,
          reason: body.reason,
          hasSnapshot: snapshot !== null,
        },
      });
    }

    reply.code(created ? 201 : 200);
    return reportResponseSchema.parse({
      id: report.id,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
    });
  });
};

/* -------------------------------------------------------------------------- */
/*  blocksModule — POST /blocks · DELETE /blocks/:userId · GET /blocks         */
/* -------------------------------------------------------------------------- */

export const blocksModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireSession);

  // ---- POST /blocks {userId} ----------------------------------------------
  // Block a user. Immediate effect: the feed + every social action already filter
  // both block directions (Slice 6). Idempotent on the (blocker,blocked) unique.
  app.post('/', async (req, reply) => {
    const me = req.user!;
    const body = createBlockRequestSchema.parse(req.body);

    if (body.userId === me.id) throw errors.validation('cannot block yourself');
    if (!isUuid(body.userId)) throw errors.notFound('user not found');

    const [target] = await db
      .select({ id: users.id, accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1);
    if (!target || target.accountStatus === 'deleted') {
      throw errors.notFound('user not found');
    }

    await db
      .insert(blocks)
      .values({ blockerId: me.id, blockedId: body.userId })
      .onConflictDoNothing({ target: [blocks.blockerId, blocks.blockedId] });

    reply.code(204).send();
  });

  // ---- DELETE /blocks/:userId ---------------------------------------------
  // Unblock (idempotent — a no-op if not blocked).
  app.delete('/:userId', async (req, reply) => {
    const me = req.user!;
    const { userId } = req.params as { userId: string };
    if (!isUuid(userId)) {
      // A malformed id can never be a real block row → nothing to remove.
      reply.code(204).send();
      return;
    }
    await db
      .delete(blocks)
      .where(and(eq(blocks.blockerId, me.id), eq(blocks.blockedId, userId)));
    reply.code(204).send();
  });

  // ---- GET /blocks ---------------------------------------------------------
  // The caller's blocked-user list, newest-first, with public user summaries.
  app.get('/', async (req, reply) => {
    const me = req.user!;
    const rows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        profilePhotoUrl: users.profilePhotoUrl,
        createdAt: blocks.createdAt,
      })
      .from(blocks)
      .innerJoin(users, eq(users.id, blocks.blockedId))
      .where(eq(blocks.blockerId, me.id))
      .orderBy(desc(blocks.createdAt));

    reply.code(200);
    return blockListResponseSchema.parse({
      items: rows.map((r) => ({
        id: r.id,
        displayName: r.displayName ?? '',
        username: r.username ?? '',
        profilePhotoUrl: isHttpUrl(r.profilePhotoUrl) ? r.profilePhotoUrl! : null,
      })),
    });
  });
};

/* ----------------------- back-compat aggregate plugin ---------------------- */

/**
 * Legacy aggregate kept so the existing app registration (`/safety` prefix) does
 * not break if referenced; the real routes are the root-mounted `reportsModule`
 * (/reports) + `blocksModule` (/blocks) per spec §8. This registers nothing.
 */
export const safetyModule: FastifyPluginAsync = async (_app) => {
  // Intentionally empty — see reportsModule / blocksModule mounted at root paths.
};

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
