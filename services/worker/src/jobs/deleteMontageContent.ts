/**
 * deleteMontageContent — the SHARED, IDEMPOTENT montage hard-delete used by every
 * montage deletion trigger (§6 "Montage deletion triggers"): 24h expiry, the
 * belt-and-suspenders sweep, replace-supersede, account purge, (and admin remove,
 * later). One code path so the deletion promise is enforced identically everywhere.
 *
 * On a live montage it:
 *   1. counts its reactions + comments + visibility rows (for the anonymized
 *      tombstone — counts ONLY, never content), inside the delete tx.
 *   2. deletes the video + thumbnail S3 objects (best-effort, idempotent — a
 *      missing object is a no-op so a leaked presigned GET 404s with the content).
 *   3. HARD-DELETES the montage row. The FK `ON DELETE CASCADE` (reaction, comment,
 *      montage_group_visibility) removes all its social in the same statement —
 *      content "lives and dies with its montage" (§6).
 *   4. writes an `audit_log` TOMBSTONE (no content — actor/action/target/counts).
 *   5. emits the §12 analytics aggregate (`expired_media_deleted_count` /
 *      `cleanup_job_result`) — ids + counts only.
 *
 * IDEMPOTENT: if the row is already gone (a prior run, the sweep beat the delayed
 * job, a double delivery) → no-op, no tombstone, no double count. The S3 deletes
 * are independently idempotent. The whole thing is safe to run twice.
 *
 * The S3 deletes happen BEFORE the row delete so that if the process dies between
 * them, the next idempotent run (sweep / replay) still finds the row and finishes
 * the S3 deletes — content is never orphaned with a live row, and a re-run with the
 * row already gone simply no-ops (the keys were captured before the row vanished).
 */
import { eq, sql } from 'drizzle-orm';
import { montages } from '@twenty4/contracts/db';
import { db as defaultDb } from '../db.js';
import { buckets, deleteObject } from '../storage.js';
import { writeAuditTombstone } from '../lib/audit.js';
import { emitAnalytics } from '../lib/analytics.js';
import type { AuditAction } from '@twenty4/contracts/enums';

type Db = typeof defaultDb;

/** Why a montage is being deleted — drives the tombstone action + analytics. */
export type MontageDeleteReason =
  | 'expired'
  | 'replaced'
  | 'account_deleted'
  | 'removed_by_admin'
  | 'deleted_by_user';

const REASON_TO_ACTION: Record<MontageDeleteReason, AuditAction> = {
  expired: 'montage_expired',
  replaced: 'montage_replaced',
  account_deleted: 'account_deleted',
  removed_by_admin: 'montage_removed_by_admin',
  deleted_by_user: 'montage_deleted_by_user',
};

export interface DeleteMontageResult {
  montageId: string;
  /** true if THIS call performed the delete; false if it was already gone (idempotent no-op). */
  deleted: boolean;
  reactionCount: number;
  commentCount: number;
  visibilityCount: number;
  /** S3 keys removed (for assertions / logging) — content already gone from S3. */
  videoKey: string | null;
  thumbnailKey: string | null;
}

/**
 * Hard-delete a montage + its content + social, write a tombstone, emit analytics.
 * Idempotent. `actorId` is the acting user for a user/admin-initiated delete, or
 * null for a system job (expiry/sweep). When `db` is a tx, the row delete + count +
 * tombstone are atomic; the S3 deletes (external) are done best-effort around it.
 */
export async function deleteMontageContent(
  montageId: string,
  reason: MontageDeleteReason,
  opts: { actorId?: string | null; db?: Db; emit?: boolean } = {},
): Promise<DeleteMontageResult> {
  const db = opts.db ?? defaultDb;
  const emit = opts.emit ?? true;

  const empty = (deleted: boolean): DeleteMontageResult => ({
    montageId,
    deleted,
    reactionCount: 0,
    commentCount: 0,
    visibilityCount: 0,
    videoKey: null,
    thumbnailKey: null,
  });

  // 1. Load the row. If it's gone, this is an idempotent no-op (already deleted).
  const [row] = await db
    .select()
    .from(montages)
    .where(eq(montages.id, montageId))
    .limit(1);
  if (!row) return empty(false);

  // Capture the S3 keys + social counts BEFORE the cascade removes the children.
  const [reactionCount, commentCount, visibilityCount] = await Promise.all([
    countWhere(db, sql`select count(*)::int as n from reaction where montage_id = ${montageId}`),
    countWhere(db, sql`select count(*)::int as n from comment where montage_id = ${montageId}`),
    countWhere(
      db,
      sql`select count(*)::int as n from montage_group_visibility where montage_id = ${montageId}`,
    ),
  ]);

  const videoKey = row.videoPath ?? null;
  const thumbnailKey = row.thumbnailPath ?? null;

  // 2. Delete S3 objects FIRST (idempotent). A missing object is a no-op, so a
  //    leaked presigned GET 404s once the content is gone (§6/§11). Done before the
  //    row delete so a crash mid-way still leaves the row for the sweep to finish.
  if (videoKey) await deleteObject(buckets.montages, videoKey);
  if (thumbnailKey) await deleteObject(buckets.thumbnails, thumbnailKey);

  // 3. HARD-DELETE the row. FK ON DELETE CASCADE removes reactions + comments +
  //    visibility in the same statement (atomic). Guard on id so a concurrent
  //    delete can't double-fire (the loser's `deleted` is empty).
  const deletedRows = await db
    .delete(montages)
    .where(eq(montages.id, montageId))
    .returning({ id: montages.id });
  if (deletedRows.length === 0) {
    // Lost a race with a concurrent deleter — they own the tombstone/analytics.
    return empty(false);
  }

  // 4. TOMBSTONE — actor/action/target/counts, NO content.
  await writeAuditTombstone(
    {
      actorId: opts.actorId ?? null,
      action: REASON_TO_ACTION[reason],
      targetType: 'montage',
      targetId: montageId,
      metadata: {
        reason,
        reactions: reactionCount,
        comments: commentCount,
        groups: visibilityCount,
        userId: row.userId,
        dayBucket: row.dayBucket,
      },
    },
    db,
  );

  // 5. §12 analytics aggregate — counts only, no content.
  if (emit) {
    emitAnalytics({
      event: 'expired_media_deleted_count',
      userId: row.userId,
      ts: Date.now(),
      count: 1,
    });
  }

  return {
    montageId,
    deleted: true,
    reactionCount,
    commentCount,
    visibilityCount,
    videoKey,
    thumbnailKey,
  };
}

/** Run a `select count(*)::int as n` and return n (0 if no row). */
async function countWhere(db: Db, query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(query)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
