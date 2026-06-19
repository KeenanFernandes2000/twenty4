/**
 * API-side admin montage removal — the in-process equivalent of the worker's
 * shared `deleteMontageContent` path (services/worker/src/jobs/deleteMontageContent.ts),
 * bound to the API's own db + S3 so an admin `POST /admin/montages/:id/remove`
 * removes content the SAME way as every other montage deletion trigger (§6):
 *
 *   1. delete the video + thumbnail S3 objects FIRST (idempotent, best-effort) so a
 *      leaked presigned GET 404s with the CONTENT, not merely hides it (§6/§11),
 *   2. HARD-DELETE the montage row inside a tx — the FK ON DELETE CASCADE removes
 *      its reactions + comments + montage_group_visibility in the same statement
 *      (content "lives and dies with its montage"), and
 *   3. write a content-free `montage_removed_by_admin` audit tombstone in the SAME
 *      tx (actor = the admin; counts only, no content).
 *
 * IDEMPOTENT: an already-gone montage → no-op (no tombstone, no double count).
 * Returns whether THIS call performed the delete + the social counts (for the
 * resolve-report / remove responses).
 */
import { eq, sql } from 'drizzle-orm';
import { montages } from '@twenty4/contracts/db';
import { db as defaultDb } from '../../db/index.js';
import { buckets, deleteObject } from '../../storage/s3.js';
import { writeAuditTombstone } from '../../lib/audit.js';

type Db = typeof defaultDb;

export interface AdminRemoveMontageResult {
  montageId: string;
  /** true if THIS call removed it; false if it was already gone (idempotent no-op). */
  removed: boolean;
  reactionCount: number;
  commentCount: number;
}

/**
 * Hard-delete a montage + its content + social as an admin, writing a tombstone.
 * Idempotent. `actorId` is the acting admin.
 */
export async function adminRemoveMontage(
  montageId: string,
  actorId: string,
  opts: { reportId?: string } = {},
): Promise<AdminRemoveMontageResult> {
  const [row] = await defaultDb
    .select()
    .from(montages)
    .where(eq(montages.id, montageId))
    .limit(1);
  if (!row) {
    return { montageId, removed: false, reactionCount: 0, commentCount: 0 };
  }

  // 1) S3 objects first (idempotent), OUTSIDE the tx — a missing object is a no-op.
  if (row.videoPath) await deleteObject(buckets.montages, row.videoPath);
  if (row.thumbnailPath) await deleteObject(buckets.thumbnails, row.thumbnailPath);

  // 2+3) ATOMIC: count → hard-delete (cascade) → tombstone, all in one tx.
  return defaultDb.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [reactionCount, commentCount] = await Promise.all([
      countWhere(txDb, sql`select count(*)::int as n from reaction where montage_id = ${montageId}`),
      countWhere(txDb, sql`select count(*)::int as n from comment where montage_id = ${montageId}`),
    ]);

    const deleted = await txDb
      .delete(montages)
      .where(eq(montages.id, montageId))
      .returning({ id: montages.id });
    if (deleted.length === 0) {
      // Lost a race with a concurrent deleter — they own the tombstone.
      return { montageId, removed: false, reactionCount: 0, commentCount: 0 };
    }

    await writeAuditTombstone(
      {
        actorId,
        action: 'montage_removed_by_admin',
        targetType: 'montage',
        targetId: montageId,
        metadata: {
          reason: 'removed_by_admin',
          reactions: reactionCount,
          comments: commentCount,
          ownerId: row.userId,
          dayBucket: row.dayBucket,
          ...(opts.reportId ? { reportId: opts.reportId } : {}),
        },
      },
      txDb,
    );

    return { montageId, removed: true, reactionCount, commentCount };
  });
}

async function countWhere(db: Db, query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(query)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
