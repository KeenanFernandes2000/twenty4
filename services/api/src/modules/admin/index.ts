/**
 * admin module (§8 Admin, internal; PLAN slice 8) — moderation + ops, behind the
 * `requireAdmin` guard (a valid+active session AND `is_admin`; a non-admin → 403,
 * audited). Mounted at /admin.
 *
 *   GET    /admin/users?q=&status=&cursor=&limit=   search by handle/email/id
 *   POST   /admin/users/:id/suspend                 → account_status=suspended + revoke sessions
 *   POST   /admin/users/:id/unsuspend               → account_status=active
 *   POST   /admin/users/:id/ban                     → account_status=banned + revoke sessions
 *   GET    /admin/reports?status=&cursor=&limit=    list/filter reports (default open)
 *   POST   /admin/reports/:id/resolve {action}      dismiss|remove_content|suspend_user|ban_user
 *   POST   /admin/montages/:id/remove               hard-delete content + tombstone (404 after)
 *   DELETE /admin/comments/:id                      hard-delete a comment + tombstone
 *   GET    /admin/ops                                queue counts + storage usage + metrics
 *
 * SUSPEND/BAN take effect IMMEDIATELY (§7.5): the action revokes the target's
 * existing sessions (delete from the session table) in the SAME tx that flips
 * account_status, so their NEXT request 401/403s through `requireSession` instead
 * of waiting for token expiry. Every admin action writes a content-free audit
 * tombstone (actor = the admin).
 */
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';
import {
  comments,
  montages,
  reports,
  session as sessionTable,
  users,
} from '@twenty4/contracts/db';
import {
  adminUserSearchQuerySchema,
  adminUserListResponseSchema,
  adminReportQuerySchema,
  adminReportListResponseSchema,
  adminResolveReportRequestSchema,
  adminResolveReportResponseSchema,
  adminRemoveContentRequestSchema,
  adminOpsResponseSchema,
  type AdminUserSummary,
  type AdminReport,
  type ReportResolveAction,
} from '@twenty4/contracts/dto';
import type { AccountStatus } from '@twenty4/contracts/enums';
import { errors } from '@twenty4/contracts/errors';

import { requireAdmin } from '../../auth/admin.js';
import { db } from '../../db/index.js';
import { buckets, bucketUsage } from '../../storage/s3.js';
import { getQueueCounts } from '../../queue/producers.js';
import { writeAuditTombstone } from '../../lib/audit.js';
import { adminRemoveMontage } from './removeMontage.js';

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/* ----------------------- shared user-status transition --------------------- */

/**
 * Apply an account-status moderation action atomically: flip account_status AND
 * (for suspend/ban) REVOKE all of the user's sessions in the SAME tx so the change
 * is immediate (§7.5) — the user's next request fails `requireSession`. Writes the
 * matching audit tombstone (actor = admin). Returns the new status. Throws 404 if
 * the target user does not exist (or is already deleted — a purged account).
 */
async function moderateUser(
  targetUserId: string,
  newStatus: AccountStatus,
  adminId: string,
  opts: { reportId?: string } = {},
): Promise<void> {
  if (!isUuid(targetUserId)) throw errors.notFound('user not found');

  const [target] = await db
    .select({ id: users.id, accountStatus: users.accountStatus })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!target || target.accountStatus === 'deleted') {
    throw errors.notFound('user not found');
  }

  const action =
    newStatus === 'suspended'
      ? 'account_suspended'
      : newStatus === 'banned'
        ? 'account_banned'
        : 'account_reinstated';

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ accountStatus: newStatus })
      .where(eq(users.id, targetUserId));

    // Suspend/ban → revoke ALL sessions immediately so it takes effect now (§7.5).
    // Reinstate does NOT mint sessions; the user signs in again.
    if (newStatus === 'suspended' || newStatus === 'banned') {
      await tx.delete(sessionTable).where(eq(sessionTable.userId, targetUserId));
    }

    await writeAuditTombstone(
      {
        actorId: adminId,
        action,
        targetType: 'user',
        targetId: targetUserId,
        metadata: {
          fromStatus: target.accountStatus,
          toStatus: newStatus,
          ...(opts.reportId ? { reportId: opts.reportId } : {}),
        },
      },
      tx as unknown as typeof db,
    );
  });
}

/* -------------------------------- comment remove --------------------------- */

/** Hard-delete a comment as an admin + write a tombstone. Idempotent (gone → 404). */
async function adminRemoveComment(
  commentId: string,
  adminId: string,
  opts: { reportId?: string } = {},
): Promise<boolean> {
  if (!isUuid(commentId)) return false;
  const [row] = await db
    .select({ id: comments.id, montageId: comments.montageId, authorId: comments.userId })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);
  if (!row) return false;

  await db.transaction(async (tx) => {
    await tx.delete(comments).where(eq(comments.id, commentId));
    await writeAuditTombstone(
      {
        actorId: adminId,
        action: 'comment_removed_by_admin',
        targetType: 'comment',
        targetId: commentId,
        metadata: {
          montageId: row.montageId,
          authorId: row.authorId,
          ...(opts.reportId ? { reportId: opts.reportId } : {}),
        },
      },
      tx as unknown as typeof db,
    );
  });
  return true;
}

/* -------------------------------------------------------------------------- */
/*  adminModule                                                                 */
/* -------------------------------------------------------------------------- */

export const adminModule: FastifyPluginAsync = async (app) => {
  // EVERY /admin/* route requires a valid admin session (a non-admin → 403 + audit).
  app.addHook('preHandler', requireAdmin);

  /* ----------------------------- GET /admin/users ------------------------- */
  app.get('/users', async (req, reply) => {
    const raw = (req.query ?? {}) as Record<string, unknown>;
    const q = adminUserSearchQuerySchema.parse({
      ...raw,
      limit: raw.limit === undefined || raw.limit === '' ? undefined : Number(raw.limit),
    });
    const limit = q.limit ?? 25;

    // Search by handle / email / exact id. citext columns make handle/email
    // case-insensitive; ILIKE is a substring match for the admin console.
    const term = q.q?.trim();
    const searchPredicate =
      term && term.length > 0
        ? or(
            ilike(sql`${users.username}::text`, `%${term}%`),
            ilike(sql`${users.email}::text`, `%${term}%`),
            ilike(sql`${users.displayName}`, `%${term}%`),
            isUuid(term) ? eq(users.id, term) : undefined,
          )
        : undefined;

    // Keyset on created_at DESC, id DESC for a stable admin scroll.
    const cursor = q.cursor ? decodeUserCursor(q.cursor) : null;
    const keyset = cursor
      ? or(
          lt(users.createdAt, new Date(cursor.createdAt)),
          and(eq(users.createdAt, new Date(cursor.createdAt)), lt(users.id, cursor.id)),
        )
      : undefined;

    const rows = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        email: users.email,
        accountStatus: users.accountStatus,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(
        and(
          q.status ? eq(users.accountStatus, q.status) : undefined,
          searchPredicate,
          keyset,
        ),
      )
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const items: AdminUserSummary[] = await Promise.all(
      page.map(async (u) => {
        const [groupCount, montageCount, reportCount] = await Promise.all([
          scalarCount(sql`select count(*)::int as n from group_members where user_id = ${u.id} and status = 'active'`),
          scalarCount(sql`select count(*)::int as n from montage where user_id = ${u.id}`),
          scalarCount(sql`select count(*)::int as n from report where target_type = 'user' and target_id = ${u.id}`),
        ]);
        return {
          id: u.id,
          displayName: u.displayName ?? '',
          username: u.username ?? '',
          accountStatus: u.accountStatus,
          groupCount,
          montageCount,
          reportCount,
          createdAt: u.createdAt.toISOString(),
        };
      }),
    );

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeUserCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;

    reply.code(200);
    return adminUserListResponseSchema.parse({ items, nextCursor });
  });

  /* --------------------- POST /admin/users/:id/suspend -------------------- */
  app.post('/users/:id/suspend', async (req, reply) => {
    const { id } = req.params as { id: string };
    await moderateUser(id, 'suspended', req.user!.id);
    reply.code(200);
    return { id, accountStatus: 'suspended' as const };
  });

  /* -------------------- POST /admin/users/:id/unsuspend ------------------- */
  app.post('/users/:id/unsuspend', async (req, reply) => {
    const { id } = req.params as { id: string };
    await moderateUser(id, 'active', req.user!.id);
    reply.code(200);
    return { id, accountStatus: 'active' as const };
  });

  /* ----------------------- POST /admin/users/:id/ban ---------------------- */
  app.post('/users/:id/ban', async (req, reply) => {
    const { id } = req.params as { id: string };
    await moderateUser(id, 'banned', req.user!.id);
    reply.code(200);
    return { id, accountStatus: 'banned' as const };
  });

  /* ---------------------------- GET /admin/reports ------------------------ */
  app.get('/reports', async (req, reply) => {
    const raw = (req.query ?? {}) as Record<string, unknown>;
    const q = adminReportQuerySchema.parse({
      ...raw,
      limit: raw.limit === undefined || raw.limit === '' ? undefined : Number(raw.limit),
    });
    const limit = q.limit ?? 25;
    // Default to the OPEN queue (the moderation worklist) when no status filter.
    const statusFilter = q.status ?? 'open';

    const cursor = q.cursor ? decodeReportCursor(q.cursor) : null;
    const keyset = cursor
      ? or(
          lt(reports.createdAt, new Date(cursor.createdAt)),
          and(eq(reports.createdAt, new Date(cursor.createdAt)), lt(reports.id, cursor.id)),
        )
      : undefined;

    const rows = await db
      .select({
        id: reports.id,
        reporterId: reports.reporterId,
        targetType: reports.targetType,
        targetId: reports.targetId,
        reason: reports.reason,
        status: reports.status,
        createdAt: reports.createdAt,
        reporterDisplayName: users.displayName,
        reporterUsername: users.username,
        reporterPhoto: users.profilePhotoUrl,
      })
      .from(reports)
      .innerJoin(users, eq(users.id, reports.reporterId))
      .where(and(eq(reports.status, statusFilter), keyset))
      .orderBy(desc(reports.createdAt), desc(reports.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items: AdminReport[] = page.map((r) => ({
      id: r.id,
      reporter: {
        id: r.reporterId,
        displayName: r.reporterDisplayName ?? '',
        username: r.reporterUsername ?? '',
        profilePhotoUrl: isHttpUrl(r.reporterPhoto) ? r.reporterPhoto! : null,
      },
      targetType: r.targetType,
      targetId: r.targetId,
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeReportCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;

    reply.code(200);
    return adminReportListResponseSchema.parse({ items, nextCursor });
  });

  /* ------------------- POST /admin/reports/:id/resolve -------------------- */
  app.post('/reports/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = req.user!.id;
    if (!isUuid(id)) throw errors.notFound('report not found');
    const body = adminResolveReportRequestSchema.parse(req.body);

    const [report] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
    if (!report) throw errors.notFound('report not found');
    if (report.status !== 'open' && report.status !== 'under_review') {
      // Already resolved — idempotent conflict (don't double-action).
      throw errors.conflict('report already resolved');
    }

    let contentRemoved = false;
    const action: ReportResolveAction = body.action;

    // Apply the side-effect to the TARGET, then close the report.
    if (action === 'remove_content') {
      if (report.targetType === 'montage') {
        const res = await adminRemoveMontage(report.targetId, adminId, { reportId: id });
        contentRemoved = res.removed;
      } else if (report.targetType === 'comment') {
        contentRemoved = await adminRemoveComment(report.targetId, adminId, { reportId: id });
      } else {
        throw errors.validation('remove_content is not valid for a user report');
      }
    } else if (action === 'suspend_user' || action === 'ban_user') {
      // Resolve the OWNER of the reported content (or the reported user directly).
      const targetUserId = await resolveReportSubjectUser(report.targetType, report.targetId);
      if (!targetUserId) throw errors.notFound('report subject not found');
      await moderateUser(
        targetUserId,
        action === 'suspend_user' ? 'suspended' : 'banned',
        adminId,
        { reportId: id },
      );
    }
    // 'dismiss' → no side-effect.

    // Close the report (actioned unless dismissed). Null the snapshot on resolve so
    // reported content isn't retained past the decision (§13) — the resolution is
    // recorded; the content snapshot is no longer needed.
    const finalStatus = action === 'dismiss' ? 'dismissed' : 'actioned';
    await db
      .update(reports)
      .set({
        status: finalStatus,
        adminAction: action,
        resolvedByAdminId: adminId,
        resolvedAt: new Date(),
        contentSnapshot: null,
        snapshotPurgeAt: null,
      })
      .where(eq(reports.id, id));

    await writeAuditTombstone({
      actorId: adminId,
      action: finalStatus === 'dismissed' ? 'report_dismissed' : 'report_actioned',
      targetType: 'report',
      targetId: id,
      metadata: {
        action,
        targetType: report.targetType,
        targetId: report.targetId,
        contentRemoved,
      },
    });

    reply.code(200);
    return adminResolveReportResponseSchema.parse({
      id,
      status: finalStatus,
      action,
      contentRemoved,
    });
  });

  /* -------------------- POST /admin/montages/:id/remove ------------------- */
  app.post('/montages/:id/remove', async (req, reply) => {
    const { id } = req.params as { id: string };
    const adminId = req.user!.id;
    if (!isUuid(id)) throw errors.notFound('montage not found');
    // Parse (optional) reason — accepted but content-free (never persisted as text).
    adminRemoveContentRequestSchema.parse(req.body ?? {});

    const res = await adminRemoveMontage(id, adminId);
    if (!res.removed) throw errors.notFound('montage not found');

    reply.code(200);
    return {
      montageId: res.montageId,
      removed: true,
      reactionsRemovedCount: res.reactionCount,
      commentsRemovedCount: res.commentCount,
    };
  });

  /* --------------------- DELETE /admin/comments/:id ----------------------- */
  app.delete('/comments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const removed = await adminRemoveComment(id, req.user!.id);
    if (!removed) throw errors.notFound('comment not found');
    reply.code(204).send();
  });

  /* ------------------------------ GET /admin/ops -------------------------- */
  app.get('/ops', async (_req, reply) => {
    const [queues, rawUsage, montageUsage, thumbUsage, metrics] = await Promise.all([
      getQueueCounts(),
      bucketUsage(buckets.raw),
      bucketUsage(buckets.montages),
      bucketUsage(buckets.thumbnails),
      (async () => {
        const [publishedMontages, activeUsers, expiredMontages, openReports] =
          await Promise.all([
            scalarCount(sql`select count(*)::int as n from montage where status = 'published' and expiry_at > now()`),
            scalarCount(sql`select count(*)::int as n from users where account_status = 'active'`),
            scalarCount(sql`select count(*)::int as n from montage where status = 'expired' or (status = 'published' and expiry_at <= now())`),
            scalarCount(sql`select count(*)::int as n from report where status = 'open'`),
          ]);
        return { publishedMontages, activeUsers, expiredMontages, openReports };
      })(),
    ]);

    reply.code(200);
    return adminOpsResponseSchema.parse({
      queues: queues.map((q) => ({
        name: q.name,
        waiting: q.waiting,
        active: q.active,
        completed: q.completed,
        failed: q.failed,
        delayed: q.delayed,
      })),
      storage: [rawUsage, montageUsage, thumbUsage].map((s) => ({
        bucket: s.bucket,
        objectCount: s.objectCount,
        bytes: s.bytes,
      })),
      metrics,
    });
  });
};

/* ------------------------------- helpers ----------------------------------- */

/**
 * Resolve the USER subject of a report: for a user report it's the target; for a
 * montage/comment report it's the OWNER/AUTHOR of that content (so suspend/ban from
 * a content report hits the right account). Returns null if the subject is gone.
 */
async function resolveReportSubjectUser(
  targetType: 'montage' | 'comment' | 'user',
  targetId: string,
): Promise<string | null> {
  if (targetType === 'user') return isUuid(targetId) ? targetId : null;
  if (!isUuid(targetId)) return null;
  if (targetType === 'montage') {
    const [m] = await db
      .select({ userId: montages.userId })
      .from(montages)
      .where(eq(montages.id, targetId))
      .limit(1);
    return m?.userId ?? null;
  }
  const [c] = await db
    .select({ userId: comments.userId })
    .from(comments)
    .where(eq(comments.id, targetId))
    .limit(1);
  return c?.userId ?? null;
}

/** Run a `select count(*)::int as n` and return n (0 if no row). */
async function scalarCount(query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(query)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
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

/* -------------------------------- cursors ---------------------------------- */

interface KeyCursor {
  createdAt: string;
  id: string;
}
function encodeCursor(c: KeyCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}
function decodeCursor(raw: string): KeyCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as KeyCursor;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('shape');
    }
    if (Number.isNaN(Date.parse(parsed.createdAt))) throw new Error('ts');
    if (!isUuid(parsed.id)) throw new Error('id');
    return parsed;
  } catch {
    throw errors.validation('invalid cursor');
  }
}
const encodeUserCursor = encodeCursor;
const decodeUserCursor = decodeCursor;
const encodeReportCursor = encodeCursor;
const decodeReportCursor = decodeCursor;
