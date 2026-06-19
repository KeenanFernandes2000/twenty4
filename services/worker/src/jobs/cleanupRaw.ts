/**
 * `cleanup-raw` job (§6 Q5) — consumes the DELAYED `cleanup-raw-<uid>-<day>` job the
 * API scheduled at publish+60min. After the grace window, ALL of the user's raw
 * media for that day_bucket (used AND unused) + any draft renders are hard-deleted
 * (rows + S3). The PUBLISHED montage that triggered this is NOT touched — it lives
 * its 24h and is owned by the expiry path.
 *
 * Idempotent: a re-delivery (or the day-close sweep having already run) finds
 * nothing left → no-op. Writes a `raw_media_purged` tombstone (counts only) and a
 * §12 `cleanup_job_result` aggregate.
 */
import { purgeRawForDay } from './purgeRawForDay.js';
import { writeAuditTombstone } from '../lib/audit.js';
import { emitAnalytics } from '../lib/analytics.js';

export interface CleanupRawResult {
  userId: string;
  dayBucket: string;
  rawRowsDeleted: number;
  draftMontagesDeleted: number;
}

/**
 * Purge raw media + draft renders for (userId, dayBucket) after the publish grace
 * window. `montageId` is the publishing montage (audit context only — it is NOT
 * deleted). Idempotent.
 */
export async function cleanupRaw(
  userId: string,
  dayBucket: string,
  montageId?: string,
): Promise<CleanupRawResult> {
  const started = Date.now();
  const res = await purgeRawForDay(userId, dayBucket, { actorId: null });

  // Tombstone only when something was actually removed (a no-op re-run stays quiet
  // so we don't accumulate empty tombstones on every redelivery).
  if (res.rawRowsDeleted > 0 || res.draftMontagesDeleted > 0) {
    await writeAuditTombstone({
      actorId: null,
      action: 'raw_media_purged',
      targetType: 'user',
      targetId: userId,
      metadata: {
        dayBucket,
        rawItems: res.rawRowsDeleted,
        draftMontages: res.draftMontagesDeleted,
        ...(montageId ? { montageId } : {}),
      },
    });
  }

  emitAnalytics({
    event: 'cleanup_job_result',
    userId,
    ts: Date.now(),
    job: 'cleanup-raw',
    ok: true,
    deletedCount: res.rawRowsDeleted + res.draftMontagesDeleted,
    durationMs: Date.now() - started,
  });

  return {
    userId,
    dayBucket,
    rawRowsDeleted: res.rawRowsDeleted,
    draftMontagesDeleted: res.draftMontagesDeleted,
  };
}
