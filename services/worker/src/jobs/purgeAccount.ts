/**
 * `purge-account` job (§5 "Account deleted → all raw media purged immediately" +
 * §6 + §11 "Account deletion purges active content within the cleanup SLA") —
 * consumes the job DELETE /users/me enqueued AFTER revoking the user's sessions and
 * marking the account `deleted`.
 *
 * Hard-deletes EVERYTHING owned by the user. The ordering matters because S3 objects
 * are NOT covered by the DB FK cascade — we must enumerate + delete the bytes FIRST
 * (raw objects, montage video/thumb), THEN drop the rows. The single `delete from
 * users` at the end relies on the schema's `ON DELETE CASCADE` FKs to remove, in one
 * statement:
 *   - daily_media_item   (user_id → users CASCADE)            [rows; S3 done above]
 *   - montage            (user_id → users CASCADE)            [rows; S3 done above]
 *       → reaction / comment / montage_group_visibility       (montage_id CASCADE)
 *   - reaction / comment authored ELSEWHERE                   (user_id → users CASCADE)
 *   - group_members                                           (user_id → users CASCADE)
 *   - groups the user OWNS                                    (owner_id → users CASCADE)
 *       → their invites / members / montages' visibility      (group_id CASCADE)
 *   - group_invites the user CREATED                          (created_by → users CASCADE)
 *   - block (both directions)                                 (blocker_id / blocked_id CASCADE)
 *   - report the user FILED                                   (reporter_id → users CASCADE)
 *   - session / account / verification (Better Auth)          (user_id → users CASCADE)
 *
 * We delete the montage CONTENT (S3 + tombstones) via the shared `deleteMontageContent`
 * path BEFORE dropping the user, so each removed montage still writes its content-free
 * tombstone and the S3 bytes are gone. Likewise every raw object is deleted from S3.
 * Then the user row delete cascades the remaining rows.
 *
 * IDEMPOTENT: a re-delivery after the user row is gone finds nothing and no-ops
 * (the final tombstone is written only when the user row actually existed this run).
 *
 * SLA: this runs promptly off the queue (the producer sets attempts+backoff); the
 * §11 "within the cleanup SLA" promise is met by enqueue-on-delete + this immediate
 * purge. We record `requestedAt` in the tombstone so SLA can be measured.
 */
import { eq, inArray, or, sql } from 'drizzle-orm';
import {
  users,
  montages,
  dailyMediaItems,
  idempotencyKeys,
  verification,
} from '@twenty4/contracts/db';
import { db } from '../db.js';
import { buckets, deleteObject } from '../storage.js';
import { deleteMontageContent } from './deleteMontageContent.js';
import { writeAuditTombstone } from '../lib/audit.js';
import { emitAnalytics } from '../lib/analytics.js';

export interface PurgeAccountResult {
  userId: string;
  purged: boolean;
  montagesDeleted: number;
  rawObjectsDeleted: number;
}

/**
 * Purge all content + the row for a deleted account. Idempotent. `requestedAt` (ISO)
 * is recorded in the tombstone for SLA measurement.
 */
export async function purgeAccount(
  userId: string,
  requestedAt?: string,
): Promise<PurgeAccountResult> {
  const started = Date.now();

  // 1. Does the user row still exist? If not → idempotent no-op (already purged).
  //    Also capture email/phone — the auth `verification` (OTP) rows are keyed by
  //    `identifier` (the email/phone), NOT by user_id, so we need them to clear OTPs.
  const [user] = await db
    .select({ id: users.id, email: users.email, phone: users.phone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    return { userId, purged: false, montagesDeleted: 0, rawObjectsDeleted: 0 };
  }

  // 2. Delete every montage the user OWNS via the shared content path: S3 video+thumb
  //    gone, FK cascade removes its reactions/comments/visibility, tombstone written.
  //    (Covers published + draft + any state.) Suppress per-montage analytics — we
  //    emit one rolled-up account tombstone + cleanup_job_result below.
  const ownedMontages = await db
    .select({ id: montages.id })
    .from(montages)
    .where(eq(montages.userId, userId));
  let montagesDeleted = 0;
  for (const m of ownedMontages) {
    const res = await deleteMontageContent(m.id, 'account_deleted', {
      actorId: userId,
      emit: false,
    });
    if (res.deleted) montagesDeleted++;
  }

  // 3. Delete every raw S3 object the user owns (the rows cascade on the user delete,
  //    but the bytes do not — remove them explicitly so nothing is orphaned in S3).
  const rawRows = await db
    .select({ storagePath: dailyMediaItems.storagePath })
    .from(dailyMediaItems)
    .where(eq(dailyMediaItems.userId, userId));
  let rawObjectsDeleted = 0;
  for (const r of rawRows) {
    if (r.storagePath) {
      await deleteObject(buckets.raw, r.storagePath);
      rawObjectsDeleted++;
    }
  }

  // 3b. Montages OWNED BY GROUPS THE USER OWNS but authored by OTHER members: when we
  //     drop the user, their owned groups cascade-delete, and any montage made visible
  //     ONLY via those groups loses its visibility row — but the montage row itself is
  //     owned by its author (not group-cascaded), so its content is the author's, not
  //     ours to purge. We intentionally do NOT delete other users' montages here; only
  //     the leaving user's group-visibility links drop with the group. (Authz already
  //     hides a montage with no surviving visible group from feeds.)

  // 3c. ROWS WITH NO FK TO users (Fix 6) — the user-delete cascade does NOT reach
  //     these, so they'd orphan forever. Delete them explicitly:
  //       • idempotency_key — `user_id` column, but NO FK to users → not cascaded.
  //       • verification    — keyed by `identifier` (the email/phone), no user link.
  //     Better Auth's OTP plugins write the verification `identifier` either as the
  //     bare email/phone OR a prefixed form (e.g. "sign-in-otp-<email>"), so match
  //     both an exact identifier and a suffix containing the user's email/phone.
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));

  const identifiers = [user.email, user.phone].filter((v): v is string => !!v);
  if (identifiers.length > 0) {
    await db.delete(verification).where(
      or(
        inArray(verification.identifier, identifiers),
        ...identifiers.map((v) => sql`${verification.identifier} like ${'%' + v}`),
      ),
    );
  }

  // 4. HARD-DELETE the user row. The schema FK cascade removes ALL remaining rows:
  //    daily_media_item, (any straggler) montages, reactions/comments authored
  //    elsewhere, group_members, owned groups (+ their invites/members/visibility),
  //    created invites, blocks (both directions), filed reports, and the Better Auth
  //    session/account rows. One statement, atomic at the DB. (verification +
  //    idempotency_key have NO FK to users → handled explicitly in 3c above.)
  await db.delete(users).where(eq(users.id, userId));

  // 5. Final account tombstone (no content) + §12 aggregate (counts only).
  await writeAuditTombstone({
    actorId: userId,
    action: 'account_deleted',
    targetType: 'user',
    targetId: userId,
    metadata: {
      montages: montagesDeleted,
      rawObjects: rawObjectsDeleted,
      ...(requestedAt ? { requestedAt } : {}),
      slaMs: Date.now() - (requestedAt ? Date.parse(requestedAt) : Date.now()),
    },
  });

  emitAnalytics({
    event: 'cleanup_job_result',
    userId,
    ts: Date.now(),
    job: 'purge-account',
    ok: true,
    deletedCount: montagesDeleted + rawObjectsDeleted,
    durationMs: Date.now() - started,
  });

  return { userId, purged: true, montagesDeleted, rawObjectsDeleted };
}
