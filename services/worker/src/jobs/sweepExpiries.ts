/**
 * `sweep-expiries` REPEATABLE job (§6 defense-in-depth) — THE CONTENT-RECLAMATION
 * BACKSTOP. It is the ONE invariant that makes the deletion promise unconditional:
 *
 *   ► The repeatable sweep reclaims ALL montage content (S3 bytes + row + social)
 *     INDEPENDENT of any delayed `expire-montage` job AND any `supersede-cleanup`
 *     job. Even if BOTH of those are lost (Redis eviction, a crash before they fire,
 *     a job that was never scheduled, a removed job), this sweep still deletes the
 *     content — on time, every tick.
 *
 * It does NOT key on a single status. The earlier version only swept
 * `status='published' AND expiry_at <= now()`, which MISSED a montage that a replace
 * had flipped to `deleted_by_user` (its content was then deletion-dependent on the
 * loss-intolerant supersede-cleanup job). The redesigned predicate catches a montage
 * that STILL HAS CONTENT but should be gone, REGARDLESS of status:
 *
 *   (status='published' AND expiry_at <= now())               -- normal 24h expiry
 *   OR (status='published' AND expiry_at IS NULL)             -- latent NULL-expiry
 *   OR (status IN ('deleted_by_user','removed_by_admin')      -- superseded/removed
 *        AND (video_path IS NOT NULL OR thumbnail_path IS NOT NULL))
 *
 * Each match is reclaimed via the shared idempotent `deleteMontageContent` path
 * (S3 video+thumb gone, row gone, FK cascade → reactions/comments/visibility gone,
 * content-free tombstone written). Because that path is idempotent, a sweep racing a
 * delayed job or a supersede-cleanup is safe: one wins the row delete, the other
 * no-ops. The `daily_media_item` raw backstop is the SEPARATE `raw-purge-sweep`.
 *
 * The predicate is driven by two partial indexes (see montage.ts): the published
 * (status, expiry_at) index, and a tiny `montage_reclaim_idx` over the terminal
 * statuses that still hold content. Both are partial so the scan stays trivially
 * small even on a large table.
 *
 * Idempotent + bounded: processes up to `limit` due montages per run; if more are
 * due they're picked up on the next tick. Emits a §12 `cleanup_job_result` aggregate
 * (counts only).
 */
import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { deleteMontageContent } from './deleteMontageContent.js';
import { emitAnalytics, SYSTEM_ACTOR } from '../lib/analytics.js';

export interface SweepExpiriesResult {
  scanned: number;
  expired: number;
  skipped: number;
}

/**
 * Sweep every montage that still holds content but should be gone, and reclaim it.
 * `now` is injectable for tests; `limit` bounds the batch so a backlog can't
 * monopolize a single run.
 */
export async function sweepExpiries(
  opts: { now?: Date; limit?: number } = {},
): Promise<SweepExpiriesResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 500;
  const started = Date.now();

  // THE BACKSTOP PREDICATE — content-bearing rows that should be gone, any status:
  //   • published past expiry (normal 24h),
  //   • published with NULL expiry (latent; a CHECK now forbids new ones but a
  //     legacy row must still be reclaimable),
  //   • terminal (deleted_by_user / removed_by_admin) rows that STILL have S3 paths
  //     (a superseded/removed montage whose content-delete job was lost).
  // Each clause is a partial-index-friendly predicate (see montage.ts).
  // NB: pass the instant as an ISO string + cast (the `postgres` driver rejects a raw
  // Date bind param in a db.execute template; ::timestamptz is exact + index-friendly).
  const nowIso = now.toISOString();
  const due = (await db.execute(sql`
    select id::text as id, status
    from montage
    where (status = 'published' and expiry_at <= ${nowIso}::timestamptz)
       or (status = 'published' and expiry_at is null)
       or (status in ('deleted_by_user', 'removed_by_admin')
           and (video_path is not null or thumbnail_path is not null))
    order by id
    limit ${limit}
  `)) as unknown as Array<{ id: string; status: string }>;

  let expired = 0;
  let skipped = 0;
  for (const m of due) {
    // The reason drives the tombstone action: a published row that's past expiry is
    // an 'expired' deletion; a terminal-status row being reclaimed is the deletion
    // its lost job should have done (supersede=replaced, admin-remove=removed).
    const reason =
      m.status === 'published'
        ? 'expired'
        : m.status === 'removed_by_admin'
          ? 'removed_by_admin'
          : 'replaced';
    // Each reclaim is independent + idempotent; one bad row can't abort the sweep.
    try {
      const res = await deleteMontageContent(m.id, reason, {
        actorId: null,
        // Suppress the per-montage expired-count analytic for a TERMINAL-status
        // reclaim (it wasn't an audience-facing expiry) — the rolled-up
        // cleanup_job_result below records the sweep. A genuine published expiry
        // still emits its count.
        emit: m.status === 'published',
      });
      if (res.deleted) expired++;
      else skipped++;
    } catch {
      skipped++;
    }
  }

  emitAnalytics({
    event: 'cleanup_job_result',
    userId: SYSTEM_ACTOR,
    ts: Date.now(),
    job: 'sweep-expiries',
    ok: true,
    deletedCount: expired,
    durationMs: Date.now() - started,
  });

  return { scanned: due.length, expired, skipped };
}
