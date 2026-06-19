/**
 * Montage visibility authorization (PLAN §3 feed authz; Slice 6 social gating).
 *
 * The single source of truth for "can this caller SEE this published montage?".
 * Both the feed read and EVERY social action (react / comment / list-comments)
 * gate on the SAME rule so a non-member or blocked user can never read or mutate
 * social on content they cannot view:
 *
 *   A montage is VISIBLE to a caller iff ALL hold:
 *     1. status = 'published'  AND  expiry_at > now  (not expired/deleted → 404),
 *     2. the caller is an ACTIVE member of ≥1 group the montage is published to
 *        (montage_group_visibility ⋈ group_member status='active'), AND
 *     3. there is NO block in EITHER direction between the caller and the owner
 *        (block table: caller↔owner, both blocker→blocked and blocked→blocker).
 *
 * `canViewMontage` returns the visible montage row + the caller's shared group
 * ids (the groups the caller and the montage have in common), or null when not
 * visible. Social handlers turn `null` into a 404 (never a 403) so a non-member
 * cannot distinguish "montage exists but you can't see it" from "no such montage"
 * — no existence leak for ephemeral content (§6/§11).
 *
 * The owner is ALWAYS allowed to view their own published montage (so an owner can
 * delete / manage it) even if no longer co-member of a shared group — but a block
 * still has no meaning against oneself, and the owner can never block themselves,
 * so the owner branch only relaxes the membership requirement.
 */
import { and, eq, gt, or } from 'drizzle-orm';
import {
  blocks,
  groupMembers,
  montageGroupVisibility,
  montages,
  type Montage,
} from '@twenty4/contracts/db';

import { db } from '../db/index.js';

/** A montage the caller may view, plus the group ids they share with it. */
export interface VisibleMontage {
  montage: Montage;
  /** The caller's ACTIVE-member groups that this montage is published to. */
  sharedGroupIds: string[];
}

/** Cheap uuid shape guard so a malformed id resolves to "not visible" (→ 404). */
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * True when a block exists in EITHER direction between `a` and `b`.
 * (a blocked b) OR (b blocked a) → filtered (both-direction filter, PLAN §3).
 */
export async function blockExistsEitherWay(a: string, b: string): Promise<boolean> {
  if (a === b) return false; // a user never blocks themselves
  const [row] = await db
    .select({ id: blocks.id })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
        and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Resolve whether `userId` can VIEW the published montage `montageId`, returning
 * the row + the caller's shared (active-member) group ids, or null if not visible.
 *
 * Not visible ⇒ the caller is a non-member, blocked (either direction), or the
 * montage is missing / not published / expired. Callers (social handlers) map
 * null → 404. The owner may always view their own LIVE published montage.
 */
export async function canViewMontage(
  montageId: string,
  userId: string,
): Promise<VisibleMontage | null> {
  if (!isUuid(montageId)) return null;

  // 1) Load the montage; must be published + not expired (live). Expired/deleted
  //    montages are GONE → treated as not found (§6).
  const [montage] = await db
    .select()
    .from(montages)
    .where(
      and(
        eq(montages.id, montageId),
        eq(montages.status, 'published'),
        gt(montages.expiryAt, new Date()),
      ),
    )
    .limit(1);
  if (!montage) return null;

  // 2) Block filter (both directions) against the owner. A block hides the content
  //    entirely (as if it doesn't exist), so this comes BEFORE the owner relaxation.
  if (userId !== montage.userId) {
    if (await blockExistsEitherWay(userId, montage.userId)) return null;
  }

  // 3) The caller's ACTIVE-member groups that this montage is published to.
  const sharedRows = await db
    .select({ groupId: montageGroupVisibility.groupId })
    .from(montageGroupVisibility)
    .innerJoin(
      groupMembers,
      and(
        eq(groupMembers.groupId, montageGroupVisibility.groupId),
        eq(groupMembers.userId, userId),
        eq(groupMembers.status, 'active'),
      ),
    )
    .where(eq(montageGroupVisibility.montageId, montageId));
  const sharedGroupIds = [...new Set(sharedRows.map((r) => r.groupId))];

  if (sharedGroupIds.length === 0) {
    // The owner may view their own montage even without a current shared group;
    // any other caller with no shared active group cannot see it.
    if (userId === montage.userId) return { montage, sharedGroupIds: [] };
    return null;
  }

  return { montage, sharedGroupIds };
}

/* -------------------------------------------------------------------------- */
/*  Feed query building blocks (used by the feed module).                      */
/* -------------------------------------------------------------------------- */

/**
 * Return the set of user ids the caller has a block relationship with in EITHER
 * direction (caller blocked them OR they blocked the caller). The feed excludes
 * montages owned by any of these users. Returned as a plain string[] so the feed
 * query can `NOT IN (...)` it (empty set ⇒ no exclusion).
 */
export async function blockedUserIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
    .from(blocks)
    .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.blockerId === userId ? r.blockedId : r.blockerId);
  }
  ids.delete(userId);
  return [...ids];
}

/** The caller's ACTIVE-member group ids (the feed's visibility scope). */
export async function activeGroupIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(and(eq(groupMembers.userId, userId), eq(groupMembers.status, 'active')));
  return [...new Set(rows.map((r) => r.groupId))];
}
