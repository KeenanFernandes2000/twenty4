/**
 * purgeRawForDay — SHARED idempotent raw-media + draft-render purge for a single
 * (user, day_bucket). Used by `cleanup-raw` (publish+60min, Q5), `day-close-sweep`
 * (unpublished media after the day closes), and the account purge (per day).
 *
 * Per §6 Q5 ("All raw media for that day_bucket (used + unused) + draft renders
 * deleted") it:
 *   1. loads the user's raw `daily_media_item` rows for the day (ALL — used+unused).
 *   2. deletes each raw S3 object (idempotent best-effort).
 *   3. hard-deletes the rows.
 *   4. deletes any NON-PUBLISHED montage renders for that day (draft_ready / failed
 *      / generating / not_generated) — their video/thumb S3 + rows + cascade social.
 *      A PUBLISHED montage is LEFT ALONE: it's live for 24h and owned by the expiry
 *      path. (deleted_by_user/removed_by_admin/expired rows are already content-free
 *      tombstone-or-gone; we still drop any lingering such row for the day so nothing
 *      stale survives, but their content was already removed.)
 *
 * IDEMPOTENT: re-running finds nothing left → no-op. S3 deletes are independently
 * idempotent. Returns counts for the §12 aggregate (no content).
 */
import { and, eq, ne } from 'drizzle-orm';
import { dailyMediaItems, montages } from '@twenty4/contracts/db';
import { db as defaultDb } from '../db.js';
import { buckets, deleteObject } from '../storage.js';
import { deleteMontageContent } from './deleteMontageContent.js';

type Db = typeof defaultDb;

export interface PurgeRawResult {
  userId: string;
  dayBucket: string;
  rawRowsDeleted: number;
  rawObjectsDeleted: number;
  draftMontagesDeleted: number;
}

/**
 * Purge ALL raw media (used + unused) + draft renders for (userId, dayBucket).
 * `actorId` is the acting user for an account purge, or null for the scheduled
 * cleanup/day-close jobs. Idempotent.
 */
export async function purgeRawForDay(
  userId: string,
  dayBucket: string,
  opts: { actorId?: string | null; db?: Db; deleteReason?: 'replaced' | 'account_deleted' | 'deleted_by_user' } = {},
): Promise<PurgeRawResult> {
  const db = opts.db ?? defaultDb;

  // 1. ALL the user's raw rows for the day (used + unused, any validation/proc state).
  const rawRows = await db
    .select({ id: dailyMediaItems.id, storagePath: dailyMediaItems.storagePath })
    .from(dailyMediaItems)
    .where(and(eq(dailyMediaItems.userId, userId), eq(dailyMediaItems.dayBucket, dayBucket)));

  // 2. delete each raw object (idempotent). A leaked presigned GET then 404s.
  let rawObjectsDeleted = 0;
  for (const r of rawRows) {
    if (r.storagePath) {
      await deleteObject(buckets.raw, r.storagePath);
      rawObjectsDeleted++;
    }
  }

  // 3. hard-delete the rows.
  if (rawRows.length > 0) {
    await db
      .delete(dailyMediaItems)
      .where(and(eq(dailyMediaItems.userId, userId), eq(dailyMediaItems.dayBucket, dayBucket)));
  }

  // 4. delete NON-PUBLISHED montage renders for the day (drafts/failed/in-flight).
  //    Published montages are LEFT for the 24h expiry path. We delete via the shared
  //    content path so their S3 + any (rare) social + row all go, with a tombstone.
  const drafts = await db
    .select({ id: montages.id })
    .from(montages)
    .where(
      and(
        eq(montages.userId, userId),
        eq(montages.dayBucket, dayBucket),
        ne(montages.status, 'published'),
      ),
    );

  let draftMontagesDeleted = 0;
  for (const m of drafts) {
    const res = await deleteMontageContent(m.id, opts.deleteReason ?? 'deleted_by_user', {
      actorId: opts.actorId ?? null,
      db,
      // Drafts had no audience; suppress the per-montage analytics aggregate (the
      // calling cleanup job emits ONE rolled-up cleanup_job_result instead).
      emit: false,
    });
    if (res.deleted) draftMontagesDeleted++;
  }

  return {
    userId,
    dayBucket,
    rawRowsDeleted: rawRows.length,
    rawObjectsDeleted,
    draftMontagesDeleted,
  };
}
