/**
 * `snapshot-purge-sweep` REPEATABLE job (§13 retention) — THE MODERATION-SNAPSHOT
 * PURGE BACKSTOP. Closes the content-survival hole where a reported montage/comment
 * snapshot (`report.content_snapshot` — reporter-visible PII) outlives the 24h
 * deletion promise and the §13 7-day retention cap.
 *
 * When a report is FILED against a montage/comment, the API captures a minimal
 * moderation snapshot into `report.content_snapshot` and stamps `snapshot_purge_at
 * = now() + 7d` (services/api/src/modules/safety/index.ts). Report RESOLUTION already
 * nulls the snapshot — but an UNRESOLVED report after 7 days had nothing purging it,
 * so its snapshot was retained INDEFINITELY (a content-survival surface).
 *
 * This sweep is the same belt-and-suspenders pattern as the Slice-7 deletion sweeps:
 * a fast, idempotent scan that nulls EVERY due snapshot independent of any other
 * lifecycle event. For every report whose `snapshot_purge_at <= now()` and still
 * carries a `content_snapshot`, it sets `content_snapshot = NULL, snapshot_purge_at
 * = NULL` and writes a CONTENT-FREE `report_snapshot_purged` audit tombstone (report
 * id + the rolled-up count only — never the purged content). Bounded by `limit`; a
 * backlog rolls to the next tick.
 *
 * IMPORTANT (§13): the +7d window is the CORRECT closure. Even when an admin/owner/
 * expiry deletes the underlying montage or comment earlier, the moderation snapshot
 * may LEGITIMATELY persist up to 7 days — so we do NOT purge early; only `now() >=
 * snapshot_purge_at` is due. Resolution still nulls it (the early, voluntary path).
 *
 * Idempotent: a re-run finds nothing due (every purged row now has a NULL snapshot
 * AND a NULL purge-at) → no-op. Emits ONE rolled-up §12 `cleanup_job_result`.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { writeAuditTombstone } from '../lib/audit.js';
import { emitAnalytics, SYSTEM_ACTOR } from '../lib/analytics.js';

export interface SnapshotPurgeSweepResult {
  scanned: number;
  snapshotsPurged: number;
}

/**
 * Null the `content_snapshot` of every report whose `snapshot_purge_at` has passed.
 * `now` is injectable for tests; `limit` bounds the batch. Returns the rolled-up
 * counts. Each purged report gets a content-free `report_snapshot_purged` tombstone.
 */
export async function snapshotPurgeSweep(
  opts: { now?: Date; limit?: number } = {},
): Promise<SnapshotPurgeSweepResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 1000;
  const started = Date.now();

  // Atomically purge a bounded batch of DUE reports (purge_at <= now AND a snapshot
  // still present). RETURNING the ids lets us tombstone each purge without re-reading
  // — and the `content_snapshot is not null` guard makes a re-run a no-op. The instant
  // is passed as an ISO string + cast (the `postgres` driver rejects a raw Date bind
  // in a template). The CTE bounds the UPDATE to `limit` rows so a backlog rolls over.
  const nowIso = now.toISOString();
  const purged = (await db.execute(sql`
    with due as (
      select id
      from report
      where snapshot_purge_at is not null
        and snapshot_purge_at <= ${nowIso}::timestamptz
        and content_snapshot is not null
      order by snapshot_purge_at asc
      limit ${limit}
    )
    update report r
       set content_snapshot = null,
           snapshot_purge_at = null
      from due
     where r.id = due.id
    returning r.id::text as id
  `)) as unknown as Array<{ id: string }>;

  // One content-free tombstone per purged report (report id only; the snapshot is
  // already gone — the tombstone records THAT a purge happened, never WHAT).
  for (const row of purged) {
    await writeAuditTombstone({
      actorId: null,
      action: 'report_snapshot_purged',
      targetType: 'report',
      targetId: row.id,
      metadata: { reason: 'retention_expired' },
    });
  }

  const snapshotsPurged = purged.length;

  emitAnalytics({
    event: 'cleanup_job_result',
    userId: SYSTEM_ACTOR,
    ts: Date.now(),
    job: 'snapshot-purge-sweep',
    ok: true,
    deletedCount: snapshotsPurged,
    durationMs: Date.now() - started,
  });

  return { scanned: snapshotsPurged, snapshotsPurged };
}
