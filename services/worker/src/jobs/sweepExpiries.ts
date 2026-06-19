/**
 * `sweep-expiries` REPEATABLE job (§6 defense-in-depth) — the BELT-AND-SUSPENDERS
 * for the per-montage delayed `expire-montage` job. If a delayed job is lost (Redis
 * eviction, a crash before it fires, a removed/never-scheduled job), this sweep
 * still deletes the content on time. Registered to run every few minutes on boot.
 *
 * It SELECTs `montage WHERE status='published' AND expiry_at <= now()` — which is
 * EXACTLY the predicate the LOAD-BEARING partial index
 * `montage_published_status_expiry_idx (status, expiry_at) WHERE status='published'`
 * is built to drive — then expires each via the shared idempotent path. Because
 * `deleteMontageContent` is idempotent, a sweep racing the delayed job is safe: one
 * wins the row delete, the other no-ops.
 *
 * Idempotent + bounded: processes up to `limit` due montages per run; if more are
 * due they're picked up on the next tick (or by their own delayed jobs). Emits a
 * §12 `cleanup_job_result` aggregate (counts only).
 */
import { and, eq, lte } from 'drizzle-orm';
import { montages } from '@twenty4/contracts/db';
import { db } from '../db.js';
import { expireMontage } from './expireMontage.js';
import { emitAnalytics, SYSTEM_ACTOR } from '../lib/analytics.js';

export interface SweepExpiriesResult {
  scanned: number;
  expired: number;
  skipped: number;
}

/**
 * Sweep due published montages and expire them. `now` is injectable for tests;
 * `limit` bounds the batch so a backlog can't monopolize a single run.
 */
export async function sweepExpiries(
  opts: { now?: Date; limit?: number } = {},
): Promise<SweepExpiriesResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 500;
  const started = Date.now();

  // Drives the partial index: status='published' AND expiry_at <= now().
  const due = await db
    .select({ id: montages.id })
    .from(montages)
    .where(and(eq(montages.status, 'published'), lte(montages.expiryAt, now)))
    .limit(limit);

  let expired = 0;
  let skipped = 0;
  for (const m of due) {
    // Each expire is independent + idempotent; one bad row can't abort the sweep.
    try {
      const res = await expireMontage(m.id);
      if (res.status === 'expired') expired++;
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
