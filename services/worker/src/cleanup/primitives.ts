// M9 cleanup — the reused deletion CORE (the §6 gate's load-bearing code).
//
// Three idempotent, crash-safe, atomic primitives reused by every cleanup path
// (one-shot jobs, replace, account-purge, admin-remove, AND the reclaim sweeps):
//   - deleteMontageHard(montageId, reason)
//   - purgeRawMedia(filter, reason)
//   - purgeAccount(userId, reason)
//
// The §10 invariants, encoded here so they cannot be re-broken per call site:
//   1. S3-FIRST then row: every S3 object is deleted BEFORE the DB tx. A crash
//      after the S3 delete leaves a still-live row pointing at gone media (the
//      SAFE failure — content is already gone, the sweep reclaims the row). It
//      NEVER leaves a tombstoned/deleted row with live S3 media (the content
//      LEAK that row-first ordering would risk).
//   2. Single DB tx for the row work + the tombstone: the montage row, its
//      reaction/comment/visibility children, AND the one audit_log tombstone
//      commit atomically. A crash anywhere in the tx rolls back ALL of it.
//   3. Idempotent convergence: re-running a partially-done delete converges and
//      produces EXACTLY ONE sanitized tombstone (never two). If the row is gone
//      at load time → no-op (no tombstone). If it vanishes mid-tx (concurrent
//      worker) → the montage-delete returns 0 rows → the tx rolls back → no
//      second tombstone.
//   4. Tombstone metadata is ALWAYS routed through sanitizeAuditMetadata — only
//      ids/counts/reason survive; never a path, comment/reaction text, or PII.
import { sanitizeAuditMetadata, type CleanupReason, type Env } from "@twenty4/contracts";
import {
  auditLog,
  block,
  comment,
  dailyMediaItem,
  groupInvite,
  groupMember,
  montage,
  montageGroupVisibility,
  reaction,
  user,
} from "@twenty4/contracts/db";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { WorkerDb } from "../db.ts";
import type { WorkerS3 } from "../s3.ts";
import { deleteObjectIdempotent } from "./s3.ts";

export interface CleanupDeps {
  db: WorkerDb;
  s3: WorkerS3;
  env: Env;
  // Bucket reported-content snapshots live in (snapshot-purge-sweep). Defaults to
  // the thumbnails bucket (snapshots are small image blobs); env/deps-overridable.
  snapshotBucket?: string;
  // Injectable clock for the sweeps' JS-side window-close math (tests pin it).
  now?: () => Date;
}

// Test-only crash-injection hooks for the §6 regression #5 (non-atomic tombstone).
// afterS3 fires AFTER the S3 deletes, BEFORE the tx opens (simulate a crash with
// media already gone + row still live). beforeTombstone fires INSIDE the tx, right
// before the audit insert (simulate a crash mid-tx → full rollback).
export interface DeleteMontageHooks {
  afterS3?: () => Promise<void> | void;
  beforeTombstone?: () => Promise<void> | void;
}

export interface DeleteMontageResult {
  deleted: boolean;
  reactionCount: number;
  commentCount: number;
  visibilityCount: number;
}

// Sentinel: the montage vanished between load and the tx commit (a concurrent
// worker won). Throwing it rolls the tx back so no second tombstone is written.
class MontageAlreadyGone extends Error {}

/**
 * Hard-delete a montage + all its children + its S3 video/thumbnail, atomically,
 * writing exactly one content-free tombstone. Idempotent: a gone montage is a
 * no-op success (NO second tombstone). S3-first → crash-safe.
 */
export async function deleteMontageHard(
  deps: CleanupDeps,
  montageId: string,
  reason: CleanupReason,
  hooks?: DeleteMontageHooks,
): Promise<DeleteMontageResult> {
  const { db, s3 } = deps;

  // Load paths + owner. Gone already ⇒ converge with no tombstone.
  const rows = await db.db
    .select({
      userId: montage.userId,
      videoPath: montage.videoPath,
      thumbnailPath: montage.thumbnailPath,
    })
    .from(montage)
    .where(eq(montage.id, montageId))
    .limit(1);
  if (rows.length === 0) {
    return { deleted: false, reactionCount: 0, commentCount: 0, visibilityCount: 0 };
  }
  const m = rows[0]!;

  // ── S3-FIRST (idempotent) ──────────────────────────────────────────────────
  // video → montages bucket; thumbnail → thumbnails bucket. Null paths (a draft
  // that never rendered) skip cleanly.
  if (m.videoPath) await deleteObjectIdempotent(s3, s3.montagesBucket, m.videoPath);
  if (m.thumbnailPath) await deleteObjectIdempotent(s3, s3.thumbnailsBucket, m.thumbnailPath);
  if (hooks?.afterS3) await hooks.afterS3();

  // ── Single DB tx: children + row + ONE tombstone (atomic) ───────────────────
  let counts = { reactionCount: 0, commentCount: 0, visibilityCount: 0 };
  try {
    await db.db.transaction(async (tx) => {
      const delReactions = await tx
        .delete(reaction)
        .where(eq(reaction.montageId, montageId))
        .returning({ id: reaction.id });
      const delComments = await tx
        .delete(comment)
        .where(eq(comment.montageId, montageId))
        .returning({ id: comment.id });
      const delVis = await tx
        .delete(montageGroupVisibility)
        .where(eq(montageGroupVisibility.montageId, montageId))
        .returning({ groupId: montageGroupVisibility.groupId });
      const delMontage = await tx
        .delete(montage)
        .where(eq(montage.id, montageId))
        .returning({ id: montage.id });
      // Concurrent worker already deleted it ⇒ roll back (no double tombstone).
      if (delMontage.length === 0) throw new MontageAlreadyGone();

      counts = {
        reactionCount: delReactions.length,
        commentCount: delComments.length,
        visibilityCount: delVis.length,
      };

      if (hooks?.beforeTombstone) await hooks.beforeTombstone();

      await tx.insert(auditLog).values({
        actorId: m.userId,
        action: "montage.deleted",
        targetType: "montage",
        targetId: montageId,
        metadata: sanitizeAuditMetadata("montage.deleted", {
          montageId,
          reason,
          reactionCount: counts.reactionCount,
          commentCount: counts.commentCount,
          visibilityCount: counts.visibilityCount,
        }),
      });
    });
  } catch (err) {
    if (err instanceof MontageAlreadyGone) {
      return { deleted: false, reactionCount: 0, commentCount: 0, visibilityCount: 0 };
    }
    throw err; // a real failure (incl. an injected beforeTombstone crash) → rolled back
  }

  return { deleted: true, ...counts };
}

// Filter for purgeRawMedia: a (user, dayBucket) slice, or an explicit id set.
export type RawPurgeFilter = { userId: string; dayBucket: string } | { userId: string; ids: string[] };

export interface PurgeRawResult {
  rows: number;
  objectsDeleted: number;
}

/**
 * Purge raw media (S3-first, then rows). One content-free summary tombstone when
 * it actually reclaims ≥1 item. Idempotent: an empty filter is a no-op (no
 * tombstone).
 */
export async function purgeRawMedia(
  deps: CleanupDeps,
  filter: RawPurgeFilter,
  reason: CleanupReason,
): Promise<PurgeRawResult> {
  const { db, s3 } = deps;

  const where =
    "ids" in filter
      ? and(eq(dailyMediaItem.userId, filter.userId), inArray(dailyMediaItem.id, filter.ids))
      : and(eq(dailyMediaItem.userId, filter.userId), eq(dailyMediaItem.dayBucket, filter.dayBucket));

  const items = await db.db
    .select({
      id: dailyMediaItem.id,
      storagePath: dailyMediaItem.storagePath,
      thumbnailPath: dailyMediaItem.thumbnailPath,
    })
    .from(dailyMediaItem)
    .where(where);

  if (items.length === 0) return { rows: 0, objectsDeleted: 0 };

  // ── S3-FIRST per item (idempotent) ─────────────────────────────────────────
  let objectsDeleted = 0;
  for (const it of items) {
    await deleteObjectIdempotent(s3, s3.rawBucket, it.storagePath);
    objectsDeleted++;
    if (it.thumbnailPath) {
      await deleteObjectIdempotent(s3, s3.thumbnailsBucket, it.thumbnailPath);
      objectsDeleted++;
    }
  }

  // ── Rows + ONE summary tombstone (atomic) ──────────────────────────────────
  const ids = items.map((i) => i.id);
  await db.db.transaction(async (tx) => {
    await tx.delete(dailyMediaItem).where(inArray(dailyMediaItem.id, ids));
    await tx.insert(auditLog).values({
      actorId: filter.userId,
      action: "raw.purged",
      targetType: "user",
      targetId: filter.userId,
      metadata: sanitizeAuditMetadata("raw.purged", {
        userId: filter.userId,
        reason,
        rows: items.length,
        objectsDeleted,
      }),
    });
  });

  return { rows: items.length, objectsDeleted };
}

export interface PurgeAccountResult {
  montages: number;
  rawRows: number;
  reactionsOnOthers: number;
  commentsOnOthers: number;
}

/**
 * Purge ALL of a user's content AND scrub their PII to satisfy "delete my account ⇒
 * PII irrecoverably gone" (§2). Steps:
 *   1. every owned montage → deleteMontageHard (cascades its reactions/comments + S3)
 *   2. all their raw media → purgeRawMedia (S3-first)
 *   3. ONE guarded tx that:
 *        - claims the purge by flipping active→deleted AND scrubbing every PII column
 *          on the user row in a SINGLE `UPDATE … WHERE account_status <> 'deleted'`.
 *          0 rows ⇒ a prior run already purged ⇒ NO-OP (no 2nd account.purged
 *          tombstone) — the account analog of deleteMontageHard's MontageAlreadyGone.
 *        - deletes the user's reactions/comments authored on OTHERS' montages + their
 *          social-graph footprint (group_member rosters, block rows in BOTH
 *          directions, group_invite rows they created).
 *        - writes ONE content-free account.purged summary tombstone.
 * The user ROW PERSISTS (scrubbed shell): audit_log.actorId is ON DELETE CASCADE, so
 * hard-deleting the row would erase the content-free tombstones that must survive.
 * Shared `group` rows are intentionally KEPT (other members rely on them; an
 * ownerless group is acceptable for MVP). Session revocation is API-side. Converges +
 * sweep-reclaimable.
 *
 * profile photo: `user.profilePhotoUrl` holds a client-supplied EXTERNAL url (PATCH
 * /users/me, z.string().url()) — NOT an object in any bucket this app owns — so there
 * is no S3 object to delete here; nulling the column removes the only stored copy.
 */
export async function purgeAccount(
  deps: CleanupDeps,
  userId: string,
  reason: CleanupReason,
): Promise<PurgeAccountResult> {
  const { db } = deps;

  // 1. Every montage the user owns → hard-delete (cascades its own reactions/comments).
  const owned = await db.db
    .select({ id: montage.id })
    .from(montage)
    .where(eq(montage.userId, userId));
  for (const mo of owned) await deleteMontageHard(deps, mo.id, reason);

  // 2. All their raw media (skip the empty-id path — nothing to purge).
  const rawIds = await allRawIds(db, userId);
  const raw =
    rawIds.length > 0
      ? await purgeRawMedia(deps, { userId, ids: rawIds }, reason)
      : { rows: 0, objectsDeleted: 0 };

  // 3. PII scrub + footprint + ONE summary tombstone (atomic, idempotency-gated).
  let reactionsOnOthers = 0;
  let commentsOnOthers = 0;
  await db.db.transaction(async (tx) => {
    // Idempotency gate FIRST: claim the purge by anonymizing the row into a PII-free
    // shell AND flipping to 'deleted' in one guarded UPDATE. Nullable PII columns are
    // NULLed; the unique citext email/username are NULLed too (their unique index is
    // partial WHERE NOT NULL, so NULL is collision-free AND leaves no value at rest).
    // A re-drain finds the row already 'deleted' → 0 rows → we skip the tombstone.
    const claimed = await tx
      .update(user)
      .set({
        displayName: null,
        username: null,
        email: null,
        phone: null,
        profilePhotoUrl: null,
        timezone: null,
        emailVerified: false,
        phoneNumberVerified: false,
        notificationPrefs: {},
        privacySettings: {},
        accountStatus: "deleted",
      })
      .where(and(eq(user.id, userId), ne(user.accountStatus, "deleted")))
      .returning({ id: user.id });
    if (claimed.length === 0) return; // already purged — converge, NO second tombstone

    // Reactions/comments the user authored on OTHERS' montages (their own went with
    // their montages in step 1's cascade).
    const delR = await tx.delete(reaction).where(eq(reaction.userId, userId)).returning({ id: reaction.id });
    const delC = await tx.delete(comment).where(eq(comment.userId, userId)).returning({ id: comment.id });
    reactionsOnOthers = delR.length;
    commentsOnOthers = delC.length;

    // Social-graph footprint: remove from every roster, both directions of every
    // block, and every invite they created. Shared `group` rows are KEPT.
    await tx.delete(groupMember).where(eq(groupMember.userId, userId));
    await tx
      .delete(block)
      .where(or(eq(block.blockerUserId, userId), eq(block.blockedUserId, userId)));
    await tx.delete(groupInvite).where(eq(groupInvite.createdBy, userId));

    // ONE account-level summary tombstone (guarded → exactly one across retries).
    await tx.insert(auditLog).values({
      actorId: userId,
      action: "account.purged",
      targetType: "user",
      targetId: userId,
      metadata: sanitizeAuditMetadata("account.purged", {
        userId,
        reason,
        montageCount: owned.length,
        rawRows: raw.rows,
        reactionCount: reactionsOnOthers,
        commentCount: commentsOnOthers,
      }),
    });
  });

  return {
    montages: owned.length,
    rawRows: raw.rows,
    reactionsOnOthers,
    commentsOnOthers,
  };
}

// Helper: every raw item id for a user (across all day buckets).
async function allRawIds(db: WorkerDb, userId: string): Promise<string[]> {
  const rows = await db.db
    .select({ id: dailyMediaItem.id })
    .from(dailyMediaItem)
    .where(eq(dailyMediaItem.userId, userId));
  return rows.map((r) => r.id);
}
