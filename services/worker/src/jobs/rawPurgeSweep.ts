/**
 * `raw-purge-sweep` REPEATABLE job (§6 raw lifecycle) — THE RAW-RECLAMATION BACKSTOP.
 *
 * The per-publish delayed `cleanup-raw` job (publish+60min) is loss-intolerant: if
 * it's evicted/crashes/never-fires, a published day's raw media would linger forever.
 * This fast sweep makes raw reclamation INDEPENDENT of that job: it hard-deletes any
 * `daily_media_item` whose `expiry_at <= now()` — exactly the rows the API now stamps
 * with `published_at + grace` at publish time (so the `daily_media_item_expiry_idx`
 * partial index actually drives this scan). A lost cleanup-raw job no longer means
 * surviving raw bytes: the next sweep tick reclaims them.
 *
 * It deletes rows+S3 DIRECTLY (not via purgeRawForDay) because it's keyed on the
 * per-ROW `expiry_at`, not per (user, day): a single user-day might have a mix and
 * only the expired rows are due. The PUBLISHED montage is never touched (it has no
 * `expiry_at` on daily_media_item; only raw rows carry it). S3 delete is best-effort
 * idempotent (a missing object 404s a leaked GET); the row delete is the source of
 * truth. Bounded by `limit`; a backlog rolls to the next tick.
 *
 * Idempotent: a re-run finds nothing due → no-op. Emits ONE §12 `cleanup_job_result`.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { buckets, deleteObject } from '../storage.js';
import { emitAnalytics, SYSTEM_ACTOR } from '../lib/analytics.js';

export interface RawPurgeSweepResult {
  scanned: number;
  rawRowsDeleted: number;
  rawObjectsDeleted: number;
}

/**
 * Sweep raw `daily_media_item` rows whose `expiry_at` has passed and hard-delete
 * them (S3 + row). `now` is injectable for tests; `limit` bounds the batch.
 */
export async function rawPurgeSweep(
  opts: { now?: Date; limit?: number } = {},
): Promise<RawPurgeSweepResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 1000;
  const started = Date.now();

  // Drives `daily_media_item_expiry_idx` (partial WHERE expiry_at IS NOT NULL):
  // grab a bounded batch of DUE raw rows (expiry_at <= now). The instant is passed as
  // an ISO string + cast — the `postgres` driver rejects a raw Date bind in a template.
  const nowIso = now.toISOString();
  const due = (await db.execute(sql`
    select id::text as id, storage_path
    from daily_media_item
    where expiry_at is not null and expiry_at <= ${nowIso}::timestamptz
    order by expiry_at asc
    limit ${limit}
  `)) as unknown as Array<{ id: string; storage_path: string | null }>;

  // Delete each raw S3 object FIRST (idempotent) so a leaked presigned GET 404s,
  // then hard-delete the row. A missing object is a no-op.
  let rawObjectsDeleted = 0;
  const ids: string[] = [];
  for (const r of due) {
    if (r.storage_path) {
      await deleteObject(buckets.raw, r.storage_path);
      rawObjectsDeleted++;
    }
    ids.push(r.id);
  }

  let rawRowsDeleted = 0;
  if (ids.length > 0) {
    const deleted = (await db.execute(sql`
      delete from daily_media_item
      where id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      returning id
    `)) as unknown as Array<{ id: string }>;
    rawRowsDeleted = deleted.length;
  }

  emitAnalytics({
    event: 'cleanup_job_result',
    userId: SYSTEM_ACTOR,
    ts: Date.now(),
    job: 'raw-purge-sweep',
    ok: true,
    deletedCount: rawRowsDeleted,
    durationMs: Date.now() - started,
  });

  return { scanned: due.length, rawRowsDeleted, rawObjectsDeleted };
}
