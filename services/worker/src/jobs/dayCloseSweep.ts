/**
 * `day-close-sweep` REPEATABLE job (§6 "Day window closes without publish → cleanup
 * job purges that day's raw media"). Runs around the 4am day close. For every
 * (user, day_bucket) whose day has CLOSED — i.e. the bucket is strictly BEFORE the
 * user's CURRENT bucket — and which has NO published montage for that day, it purges
 * the user's raw media + draft renders (rows + S3) via the shared `purgeRawForDay`.
 *
 * A published day is left to the `cleanup-raw` path (publish+60min already removes
 * its raw). This sweep specifically catches the UNPUBLISHED case: the user added
 * media but never published before the window rolled over — that raw must not linger.
 *
 * Day-close decision uses the shared `resolveDayBucket` from @twenty4/contracts so
 * the 4am→4am window matches the API exactly. The "current" bucket is resolved per
 * device tz on the row (the tz the media was captured/uploaded in); falling back to
 * UTC when absent. A day is closed when its bucket < the current bucket in that tz.
 *
 * Idempotent: a re-run finds those days already purged → no-op. Emits ONE rolled-up
 * §12 `cleanup_job_result` (counts only).
 */
import { sql } from 'drizzle-orm';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import { db } from '../db.js';
import { env } from '../env.js';
import { purgeRawForDay } from './purgeRawForDay.js';
import { writeAuditTombstone } from '../lib/audit.js';
import { emitAnalytics, SYSTEM_ACTOR } from '../lib/analytics.js';

export interface DayCloseSweepResult {
  candidates: number;
  purgedDays: number;
  rawRowsDeleted: number;
  draftMontagesDeleted: number;
}

/** One (user, day, tz) candidate group with raw media. */
interface Candidate {
  userId: string;
  dayBucket: string;
  deviceTimezone: string | null;
}

/**
 * Sweep CLOSED, UNPUBLISHED days and purge their raw media + drafts. `now` is
 * injectable for tests. `limit` bounds the candidate batch.
 */
export async function dayCloseSweep(
  opts: { now?: Date; limit?: number } = {},
): Promise<DayCloseSweepResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 1000;
  const started = Date.now();
  const offset = env.DAY_WINDOW_OFFSET_HOURS;

  // Distinct (user, day_bucket, device_timezone) groups that still have raw media.
  // We pick a representative device_timezone per group (max) — within a single
  // user-day the tz is effectively constant; this just resolves "today" for the
  // closed-ness test deterministically.
  const groups = (await db.execute(sql`
    select user_id::text as user_id,
           day_bucket::text as day_bucket,
           max(device_timezone) as device_timezone
    from daily_media_item
    group by user_id, day_bucket
    order by day_bucket asc
    limit ${limit}
  `)) as unknown as Array<{ user_id: string; day_bucket: string; device_timezone: string | null }>;

  const candidates: Candidate[] = groups.map((g) => ({
    userId: g.user_id,
    dayBucket: g.day_bucket,
    deviceTimezone: g.device_timezone,
  }));

  let purgedDays = 0;
  let rawRowsDeleted = 0;
  let draftMontagesDeleted = 0;

  for (const c of candidates) {
    const tz = c.deviceTimezone ?? 'UTC';
    let currentBucket: string;
    try {
      currentBucket = resolveDayBucket(now, tz, offset);
    } catch {
      currentBucket = resolveDayBucket(now, 'UTC', offset);
    }

    // Only CLOSED days (strictly before the current bucket in that tz). A day still
    // open (today, or a future-dated edge) is left alone — the user may yet publish.
    if (c.dayBucket >= currentBucket) continue;

    // Skip days that HAVE a published montage — their raw is the cleanup-raw path's
    // job (publish+60min), not this sweep's. (A published-then-expired day's raw was
    // already purged; if any raw lingers we still purge it below as belt-and-braces,
    // but a CURRENTLY-published montage must keep its raw out of THIS path so we
    // don't race the 60-min grace. We treat "ever published for this day" as a skip.)
    const published = (await db.execute(sql`
      select 1 from montage
      where user_id = ${c.userId}
        and day_bucket = ${c.dayBucket}
        and status = 'published'
      limit 1
    `)) as unknown as Array<unknown>;
    if (published.length > 0) continue;

    const res = await purgeRawForDay(c.userId, c.dayBucket, { actorId: null });
    if (res.rawRowsDeleted > 0 || res.draftMontagesDeleted > 0) {
      purgedDays++;
      rawRowsDeleted += res.rawRowsDeleted;
      draftMontagesDeleted += res.draftMontagesDeleted;
      await writeAuditTombstone({
        actorId: null,
        action: 'raw_media_purged',
        targetType: 'user',
        targetId: c.userId,
        metadata: {
          dayBucket: c.dayBucket,
          rawItems: res.rawRowsDeleted,
          draftMontages: res.draftMontagesDeleted,
          reason: 'day_close_no_publish',
        },
      });
    }
  }

  emitAnalytics({
    event: 'cleanup_job_result',
    userId: SYSTEM_ACTOR,
    ts: Date.now(),
    job: 'day-close-sweep',
    ok: true,
    deletedCount: rawRowsDeleted + draftMontagesDeleted,
    durationMs: Date.now() - started,
  });

  return {
    candidates: candidates.length,
    purgedDays,
    rawRowsDeleted,
    draftMontagesDeleted,
  };
}
