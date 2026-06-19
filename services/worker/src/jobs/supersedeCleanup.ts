/**
 * `supersede-cleanup` job (§6 Q2 replace cascade) — consumes the job
 * POST /montages/:id/replace enqueues after publishing the replacement and marking
 * the PRIOR montage superseded (status=deleted_by_user, superseded_by=replacement).
 *
 * It hard-deletes the prior montage's content via the shared `deleteMontageContent`
 * path: S3 video+thumb gone, row gone (FK cascade → its reactions/comments/
 * visibility gone), a `montage_replaced` tombstone written (no content). The
 * replacement (M2) is untouched and lives with its own fresh 24h clock.
 *
 * IDEMPOTENT: the prior row may already be gone (a redelivery, or the replace flow's
 * row already cascade-removed) → no-op. The actor is the OWNER (the prior montage's
 * user) — replace is a user action.
 */
import { eq } from 'drizzle-orm';
import { montages } from '@twenty4/contracts/db';
import { db } from '../db.js';
import { deleteMontageContent } from './deleteMontageContent.js';

export interface SupersedeCleanupResult {
  priorMontageId: string;
  status: 'deleted' | 'skipped';
  reason?: string;
}

/**
 * Hard-delete a superseded (prior) montage's content. Idempotent. Looks up the
 * owner from the row so the tombstone actor is correct; a missing row no-ops.
 */
export async function supersedeCleanup(
  priorMontageId: string,
): Promise<SupersedeCleanupResult> {
  const [row] = await db
    .select({ userId: montages.userId })
    .from(montages)
    .where(eq(montages.id, priorMontageId))
    .limit(1);
  if (!row) {
    return { priorMontageId, status: 'skipped', reason: 'row_missing' };
  }

  const res = await deleteMontageContent(priorMontageId, 'replaced', {
    actorId: row.userId,
    // Suppress the expired-count analytics for a replace (it wasn't an expiry); the
    // tombstone records the replace. (A dedicated replace analytic could be added.)
    emit: false,
  });

  return res.deleted
    ? { priorMontageId, status: 'deleted' }
    : { priorMontageId, status: 'skipped', reason: 'raced' };
}
