/**
 * `day-close-sweep` REPEATABLE job (§6 "Day window closes → cleanup job purges that
 * day's raw media"). Runs around the 4am day close. For every (user, day_bucket)
 * whose day has CLOSED — i.e. the bucket is strictly BEFORE the user's CURRENT
 * bucket in that device tz — it reclaims everything that is now OBSOLETE:
 *
 *   1. RAW media + draft renders for the day, for EVERY closed day — PUBLISHED OR
 *      NOT. Once a day closes the raw is obsolete regardless of whether the user
 *      published: the published montage lives on INDEPENDENTLY (its own 24h expiry
 *      owns it; its video lives in the montages bucket, not in raw). The earlier
 *      version SKIPPED published days, which left a published day's raw dependent on
 *      the loss-intolerant +60min cleanup-raw job. We no longer skip — `purgeRawForDay`
 *      itself leaves a PUBLISHED montage row alone (it only deletes raw + NON-published
 *      renders), so purging here can never touch live published content.
 *
 *   2. ORPHAN NON-PUBLISHED montage rows (draft_ready / failed / generating /
 *      not_generated) on a closed day, EVEN IF their raw is already gone. The
 *      previous design only deleted such rows as a side effect of `purgeRawForDay`,
 *      and only when raw rows still existed — so a draft on a closed day whose raw was
 *      already swept would survive forever. We now ALSO scan montages directly for
 *      closed-day non-published rows and reclaim them via the shared content path.
 *
 * Day-close decision uses the shared `resolveDayBucket` from @twenty4/contracts so
 * the 4am→4am window matches the API exactly. The "current" bucket is resolved per
 * device tz (the tz the media was captured/uploaded in), falling back to UTC.
 *
 * Idempotent: a re-run finds those days already purged → no-op. Emits ONE rolled-up
 * §12 `cleanup_job_result` (counts only).
 */
import { sql } from 'drizzle-orm';
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import { db } from '../db.js';
import { env } from '../env.js';
import { purgeRawForDay } from './purgeRawForDay.js';
import { deleteMontageContent } from './deleteMontageContent.js';
import { writeAuditTombstone } from '../lib/audit.js';
import { emitAnalytics, SYSTEM_ACTOR } from '../lib/analytics.js';

export interface DayCloseSweepResult {
  candidates: number;
  purgedDays: number;
  rawRowsDeleted: number;
  draftMontagesDeleted: number;
}

/** One (user, day, tz) candidate group. */
interface Candidate {
  userId: string;
  dayBucket: string;
  deviceTimezone: string | null;
}

/**
 * Sweep CLOSED days and reclaim their raw media + drafts + orphan non-published
 * montages. `now` is injectable for tests. `limit` bounds the candidate batch.
 */
export async function dayCloseSweep(
  opts: { now?: Date; limit?: number } = {},
): Promise<DayCloseSweepResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 1000;
  const started = Date.now();
  const offset = env.DAY_WINDOW_OFFSET_HOURS;

  // Candidate (user, day, tz) groups from BOTH sources of closed-day debris: days
  // that still have raw `daily_media_item` rows, AND days that still have a
  // NON-published montage row (the orphan-draft case — Fix 3 — where raw is already
  // gone but a draft/failed row lingers). UNION so each closed day is considered once.
  const groups = (await db.execute(sql`
    select user_id::text as user_id,
           day_bucket::text as day_bucket,
           max(device_timezone) as device_timezone
    from (
      select user_id, day_bucket, device_timezone
        from daily_media_item
      union all
      select user_id, day_bucket, null::text as device_timezone
        from montage
       where status not in ('published', 'expired')
    ) src
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

    // RAW + DRAFTS: purge for EVERY closed day, published or not. purgeRawForDay
    // deletes raw rows+S3 and NON-published renders only — a live PUBLISHED montage
    // for the day is left untouched (it owns its own 24h expiry path). So there's no
    // "skip published days" gate any more: once a day closes its raw is obsolete.
    const res = await purgeRawForDay(c.userId, c.dayBucket, { actorId: null });

    // ORPHAN NON-PUBLISHED MONTAGES (Fix 3): purgeRawForDay already deletes
    // non-published renders, but it ran in the SAME pass; this second scan exists so
    // that a draft whose raw was ALREADY gone (so it wasn't a raw candidate, and
    // purgeRawForDay found nothing) is still reclaimed. It's keyed purely on the
    // montage table, independent of any surviving raw rows. Idempotent — anything
    // purgeRawForDay just removed is no longer here.
    const orphanDrafts = (await db.execute(sql`
      select id::text as id
      from montage
      where user_id = ${c.userId}
        and day_bucket = ${c.dayBucket}
        and status not in ('published', 'expired')
    `)) as unknown as Array<{ id: string }>;
    let orphansDeleted = 0;
    for (const m of orphanDrafts) {
      const del = await deleteMontageContent(m.id, 'deleted_by_user', {
        actorId: null,
        emit: false,
      });
      if (del.deleted) orphansDeleted++;
    }

    const dayDraftsDeleted = res.draftMontagesDeleted + orphansDeleted;
    if (res.rawRowsDeleted > 0 || dayDraftsDeleted > 0) {
      purgedDays++;
      rawRowsDeleted += res.rawRowsDeleted;
      draftMontagesDeleted += dayDraftsDeleted;
      await writeAuditTombstone({
        actorId: null,
        action: 'raw_media_purged',
        targetType: 'user',
        targetId: c.userId,
        metadata: {
          dayBucket: c.dayBucket,
          rawItems: res.rawRowsDeleted,
          draftMontages: dayDraftsDeleted,
          reason: 'day_close',
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
