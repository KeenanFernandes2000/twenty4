/**
 * `expire-montage` job (§6 24h expiry) — consumes the DELAYED `expire-<id>` job the
 * API scheduled at publish+24h. THE CORE PROMISE: at 24h the montage's content +
 * social are hard-deleted and only an anonymized tombstone + aggregate count remain.
 *
 * Flow (idempotent):
 *   1. re-read the montage row. Gone → no-op (already expired/replaced/purged).
 *   2. if it's already terminal (expired/deleted_by_user/removed_by_admin) → no-op
 *      — a prior trigger (replace/admin/sweep) already deleted it; nothing to do.
 *      NOTE: in this design the row is HARD-DELETED on expiry (no lingering
 *      status=expired row) per §6 ("delete montage row") — content + row both gone.
 *      The only thing that persists is the audit tombstone + analytics aggregate.
 *   3. otherwise delete it via the shared `deleteMontageContent` path:
 *      S3 video+thumb gone, row gone (FK cascade → reactions/comments/visibility
 *      gone), tombstone written (no content), §12 aggregate emitted.
 *
 * A published montage past its expiry is the normal case; we don't re-check the
 * clock here because the delayed job fires AT expiry and the API only schedules it
 * for a published row — but the belt-and-suspenders `sweepExpiries` is the safety
 * net for a lost/failed delayed job, and it DOES gate on `expiry_at <= now()`.
 */
import { eq } from 'drizzle-orm';
import { montages } from '@twenty4/contracts/db';
import { db } from '../db.js';
import { deleteMontageContent } from './deleteMontageContent.js';

export interface ExpireMontageResult {
  montageId: string;
  status: 'expired' | 'skipped';
  reason?: string;
  reactionCount?: number;
  commentCount?: number;
}

/** Terminal statuses where the content is already gone (or never was live). */
const ALREADY_GONE = new Set([
  'expired',
  'deleted_by_user',
  'removed_by_admin',
]);

/**
 * Expire (hard-delete) a montage by id. Idempotent: a missing row or an
 * already-terminal status is a safe no-op. The actor is the SYSTEM (null) — this
 * is a scheduled background deletion, not a user action.
 */
export async function expireMontage(montageId: string): Promise<ExpireMontageResult> {
  const [row] = await db
    .select({ id: montages.id, status: montages.status })
    .from(montages)
    .where(eq(montages.id, montageId))
    .limit(1);

  if (!row) {
    return { montageId, status: 'skipped', reason: 'row_missing' };
  }
  if (ALREADY_GONE.has(row.status)) {
    return { montageId, status: 'skipped', reason: `already_${row.status}` };
  }

  const res = await deleteMontageContent(montageId, 'expired', { actorId: null });
  if (!res.deleted) {
    // A concurrent deleter won the race (sweep vs delayed job) — that run owns it.
    return { montageId, status: 'skipped', reason: 'raced' };
  }
  return {
    montageId,
    status: 'expired',
    reactionCount: res.reactionCount,
    commentCount: res.commentCount,
  };
}
