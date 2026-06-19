/**
 * Group membership authorization helpers (§8 cross-cutting; PLAN §3 authz).
 *
 * Every group sub-resource (members, invites, montage visibility, …) MUST be
 * gated by membership. These helpers centralize that check so a non-member can
 * never read or mutate a group they don't belong to.
 *
 * Leak policy (per spec/PLAN): a group's existence is NOT a secret to an
 * authenticated user the way private content is — but its *contents* are. We
 * reject non-members with `forbidden` (403), NOT `not_found`, because:
 *   - the caller is authenticated (not anonymous), and
 *   - groups are reachable by id only if you already hold the id, so a 403 does
 *     not enable enumeration of group contents.
 * (Expired/deleted *content* still 404s elsewhere per §6; that is a different
 * rule for ephemeral media, not for group authz.)
 *
 * `status='active'` is required: a member who has `left`/`been removed` keeps a
 * row (audit) but is treated as a non-member for authz.
 */
import { and, eq } from 'drizzle-orm';
import { groupMembers, groups, type Group, type GroupMember } from '@twenty4/contracts/db';
import type { GroupMemberRole } from '@twenty4/contracts/enums';
import { errors } from '@twenty4/contracts/errors';

import { db } from '../db/index.js';

/** A resolved, ACTIVE membership row for (groupId, userId). */
export type ActiveMembership = GroupMember;

/**
 * Look up the caller's ACTIVE membership in a group. Returns null if the caller
 * is not an active member (left/removed/never-joined all → null).
 *
 * Accepts an optional transaction-bound db so it can run inside a join/leave txn.
 */
export async function getMembership(
  groupId: string,
  userId: string,
  conn: Pick<typeof db, 'select'> = db,
): Promise<ActiveMembership | null> {
  const [row] = await conn
    .select()
    .from(groupMembers)
    .where(
      and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, userId),
        eq(groupMembers.status, 'active'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Assert the caller is an ACTIVE member of the group. Returns the membership row
 * on success; throws `forbidden` (403) otherwise.
 *
 * We intentionally collapse "group does not exist" and "caller is not a member"
 * into a single 403 — this helper never confirms or denies a group's existence
 * to a non-member (no existence-leak), so it does NOT take the group row or
 * distinguish 404 from 403. Handlers that genuinely need the group row (to read
 * name/photo/status) load it separately via `loadGroupOr404`, which is NOT
 * authorization.
 */
export async function assertMemberOf(
  groupId: string,
  userId: string,
): Promise<ActiveMembership> {
  const membership = await getMembership(groupId, userId);
  if (!membership) {
    throw errors.forbidden('not a member of this group');
  }
  return membership;
}

/**
 * Assert the caller is an active member AND holds one of `roles`. Returns the
 * membership row. A non-member → 403 forbidden ("not a member"); a member with
 * the wrong role → 403 forbidden ("insufficient role"). The two messages are
 * intentionally different so the client can distinguish, but both are 403 (we
 * never leak that the caller IS a member when they lack the role — a 403 either
 * way is consistent).
 */
export async function assertRole(
  groupId: string,
  userId: string,
  roles: readonly GroupMemberRole[],
): Promise<ActiveMembership> {
  const membership = await assertMemberOf(groupId, userId);
  if (!roles.includes(membership.role)) {
    throw errors.forbidden('insufficient role for this action', {
      requiredRoles: roles,
    });
  }
  return membership;
}

/**
 * Load a group by id or throw 404. Used by handlers that need the group row
 * itself (name/photo/owner/status). NOTE: callers that need membership should
 * still `assertMemberOf` — loading the group is NOT authorization.
 */
export async function loadGroupOr404(groupId: string): Promise<Group> {
  const [row] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!row) throw errors.notFound('group not found');
  return row;
}

/** Numeric rank for role hierarchy comparisons (owner > admin > member). */
export const ROLE_RANK: Record<GroupMemberRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

/** True when `actor` outranks `target` strictly (e.g. admin can remove member). */
export function outranks(actor: GroupMemberRole, target: GroupMemberRole): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}
