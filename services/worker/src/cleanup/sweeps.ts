// M9 cleanup — the defense-in-depth reclaim SWEEPS (the authoritative backstop).
//
// Delayed/one-shot jobs are best-effort; a dropped job must NEVER leave content
// alive. Each repeatable sweep re-derives "what is past-due but still alive" from
// the DB and re-drives the matching primitive. The §6 suite proves every lost-job
// case is reclaimed here (regressions #1–#3, #6). Candidate selection uses raw SQL
// (EXISTS / self-join / tz-aware window math) for clarity; the primitives own the
// atomic delete + tombstone.
import { resolveDayBucket, sanitizeAuditMetadata } from "@twenty4/contracts";
import { auditLog, report } from "@twenty4/contracts/db";
import { eq } from "drizzle-orm";
import type { CleanupDeps } from "./primitives.ts";
import { deleteMontageHard, purgeRawMedia } from "./primitives.ts";
import { deleteObjectIdempotent } from "./s3.ts";

function nowOf(deps: CleanupDeps): Date {
  return deps.now ? deps.now() : new Date();
}

export interface SweepExpiriesResult {
  expiredReclaimed: number;
  orphanDraftsReclaimed: number;
}

/**
 * Reclaim every logically-dead montage still alive:
 *   - published AND expiry_at <= now()            (past its own contract)
 *   - published AND expiry_at IS NULL             (defense; the CHECK forbids it)
 *   - published AND superseded_by → a PUBLISHED successor   (regression #1: a
 *     replaced prior whose delete was dropped — reclaimed even though the prior
 *     is NOT yet past its own expiry)
 *   - orphan drafts: a non-published montage whose day-window has CLOSED (the
 *     user can no longer publish it) → dead (regression #3).
 */
export async function sweepExpiries(deps: CleanupDeps): Promise<SweepExpiriesResult> {
  const { db } = deps;

  // Logically-dead PUBLISHED montages.
  const dead = await db.sql<{ id: string }[]>`
    SELECT m.id FROM montage m
    WHERE m.status = 'published' AND (
      m.expiry_at <= now()
      OR m.expiry_at IS NULL
      OR EXISTS (
        SELECT 1 FROM montage s
        WHERE s.id = m.superseded_by AND s.status = 'published'
      )
    )`;
  let expiredReclaimed = 0;
  for (const row of dead) {
    const res = await deleteMontageHard(deps, row.id, "swept_expired");
    if (res.deleted) expiredReclaimed++;
  }

  // Orphan drafts: never-published montages whose window has closed.
  const draftCandidates = await db.sql<{ id: string; day_bucket: string; tz: string }[]>`
    SELECT m.id, m.day_bucket::text AS day_bucket, COALESCE(u.timezone, 'UTC') AS tz
    FROM montage m JOIN "user" u ON u.id = m.user_id
    WHERE m.status IN ('not_generated', 'generating', 'draft_ready', 'failed')
      AND m.published_at IS NULL`;
  const now = nowOf(deps);
  let orphanDraftsReclaimed = 0;
  for (const c of draftCandidates) {
    const currentBucket = resolveDayBucket(now, c.tz);
    if (currentBucket > c.day_bucket) {
      const res = await deleteMontageHard(deps, c.id, "swept_orphan_draft");
      if (res.deleted) orphanDraftsReclaimed++;
    }
  }

  return { expiredReclaimed, orphanDraftsReclaimed };
}

export interface SweepRawPurgeResult {
  bucketsReclaimed: number;
}

/**
 * Reclaim raw media past its published-grace purge-due time still alive: any
 * (user, dayBucket) with a PUBLISHED montage whose published_at + grace has
 * passed AND surviving raw items (regression #2: a dropped +grace raw-purge job).
 */
export async function sweepRawPurge(deps: CleanupDeps): Promise<SweepRawPurgeResult> {
  const { db, env } = deps;
  const graceMin = env.RAW_PURGE_GRACE_MIN;

  const buckets = await db.sql<{ user_id: string; day_bucket: string }[]>`
    SELECT DISTINCT m.user_id, m.day_bucket::text AS day_bucket
    FROM montage m
    WHERE m.status = 'published'
      AND m.published_at + (${graceMin} * interval '1 minute') <= now()
      AND EXISTS (
        SELECT 1 FROM daily_media_item d
        WHERE d.user_id = m.user_id AND d.day_bucket = m.day_bucket
      )`;

  let bucketsReclaimed = 0;
  for (const b of buckets) {
    const res = await purgeRawMedia(deps, { userId: b.user_id, dayBucket: b.day_bucket }, "published_grace");
    if (res.rows > 0) bucketsReclaimed++;
  }
  return { bucketsReclaimed };
}

export interface SweepDayCloseResult {
  bucketsReclaimed: number;
}

/**
 * Reclaim raw media from CLOSED (4am-local passed) day-windows that were never
 * published. Tz-aware: a bucket is closed when the user's current day-bucket is
 * strictly later than the item's bucket.
 */
export async function sweepDayClose(deps: CleanupDeps): Promise<SweepDayCloseResult> {
  const { db } = deps;

  const candidates = await db.sql<{ user_id: string; day_bucket: string; tz: string }[]>`
    SELECT DISTINCT d.user_id, d.day_bucket::text AS day_bucket, COALESCE(u.timezone, 'UTC') AS tz
    FROM daily_media_item d JOIN "user" u ON u.id = d.user_id
    WHERE NOT EXISTS (
      SELECT 1 FROM montage m
      WHERE m.user_id = d.user_id AND m.day_bucket = d.day_bucket AND m.status = 'published'
    )`;

  const now = nowOf(deps);
  let bucketsReclaimed = 0;
  for (const c of candidates) {
    const currentBucket = resolveDayBucket(now, c.tz);
    if (currentBucket > c.day_bucket) {
      const res = await purgeRawMedia(deps, { userId: c.user_id, dayBucket: c.day_bucket }, "window_closed");
      if (res.rows > 0) bucketsReclaimed++;
    }
  }
  return { bucketsReclaimed };
}

export interface SweepSnapshotPurgeResult {
  snapshotsPurged: number;
}

/**
 * Reclaim reported-content snapshots past their retention window (the slice-8 PII
 * hole, regression #6): report rows where retain_until <= now() AND snapshot_path
 * IS NOT NULL → S3-delete the snapshot, NULL out snapshot_path + snapshot_metadata,
 * write a content-free tombstone per report.
 */
export async function sweepSnapshotPurge(deps: CleanupDeps): Promise<SweepSnapshotPurgeResult> {
  const { db, s3 } = deps;
  // startCleanupWorkers now sets deps.snapshotBucket EXPLICITLY (env SNAPSHOT_BUCKET,
  // defaulting to the thumbnails bucket). The `?? thumbnailsBucket` stays only as a
  // belt-and-suspenders for direct/test callers. M12 COUPLING TRAP: the report-WRITE
  // flow MUST store snapshots in THIS same bucket or this sweep can't reclaim them.
  const snapshotBucket = deps.snapshotBucket ?? s3.thumbnailsBucket;

  const rows = await db.sql<{ id: string; reporter_user_id: string; snapshot_path: string }[]>`
    SELECT id, reporter_user_id, snapshot_path FROM report
    WHERE retain_until <= now() AND snapshot_path IS NOT NULL`;

  let snapshotsPurged = 0;
  for (const r of rows) {
    // S3-FIRST: strip the snapshot object (idempotent).
    await deleteObjectIdempotent(s3, snapshotBucket, r.snapshot_path);
    // Then NULL the PII columns + tombstone, atomically.
    await db.db.transaction(async (tx) => {
      await tx
        .update(report)
        .set({ snapshotPath: null, snapshotMetadata: null })
        .where(eq(report.id, r.id));
      await tx.insert(auditLog).values({
        actorId: r.reporter_user_id,
        action: "report.snapshot_purged",
        targetType: "report",
        targetId: r.id,
        metadata: sanitizeAuditMetadata("report.snapshot_purged", {
          reportId: r.id,
          objectsDeleted: 1,
        }),
      });
    });
    snapshotsPurged++;
  }
  return { snapshotsPurged };
}
