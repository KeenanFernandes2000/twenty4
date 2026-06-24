// Group authorization — the SINGLE shared gate (M3 §10 learning). Every
// group-scoped route MUST call assertMemberOf or assertOwnerOf; there are NO
// inline ad-hoc membership checks. Reused by M4 (media), M7 (montage), M8 (feed).
//
//  - assertMemberOf: throws NOT_A_MEMBER unless an ACTIVE membership exists.
//  - assertOwnerOf: throws NOT_OWNER unless the caller is the group's owner via an
//    ACTIVE owner-role membership. Throws GROUP_NOT_FOUND if the group is gone /
//    archived (so a non-member can't probe existence — owner check resolves the
//    group first; member check returns NOT_A_MEMBER without leaking existence).
import { and, eq } from "drizzle-orm";
import { GroupNotFoundError, NotAMemberError, NotOwnerError } from "@twenty4/contracts";
import { group as groupTable, groupMember } from "@twenty4/contracts/db";
import type { DbClient } from "../db.ts";

// Returns the caller's active-membership row (role) or undefined.
export async function activeMembership(
  db: DbClient,
  groupId: string,
  userId: string,
): Promise<{ role: "owner" | "admin" | "member" } | undefined> {
  const rows = await db.db
    .select({ role: groupMember.role })
    .from(groupMember)
    .where(and(eq(groupMember.groupId, groupId), eq(groupMember.userId, userId), eq(groupMember.status, "active")))
    .limit(1);
  return rows[0];
}

// Throws NOT_A_MEMBER unless the caller has an active membership in the group.
// Returns the caller's role on success. Does NOT leak group existence to non-
// members (a non-member of an existing group and of a missing group both 403).
export async function assertMemberOf(
  db: DbClient,
  groupId: string,
  userId: string,
): Promise<"owner" | "admin" | "member"> {
  const m = await activeMembership(db, groupId, userId);
  if (!m) throw new NotAMemberError();
  return m.role;
}

// Throws NOT_OWNER unless the caller is the group's owner (active owner-role
// membership AND group.owner_id === userId). Resolves the group first so an
// owner-only action on a missing/archived group is GROUP_NOT_FOUND, and a
// non-owner member gets NOT_OWNER. The group row is returned for handler reuse.
export async function assertOwnerOf(
  db: DbClient,
  groupId: string,
  userId: string,
): Promise<typeof groupTable.$inferSelect> {
  const rows = await db.db
    .select()
    .from(groupTable)
    .where(and(eq(groupTable.id, groupId), eq(groupTable.status, "active")))
    .limit(1);
  const g = rows[0];
  if (!g) throw new GroupNotFoundError();
  // Owner identity is the group.owner_id; also require an active owner membership
  // so a demoted/left owner row can't wield powers (defense-in-depth).
  if (g.ownerId !== userId) throw new NotOwnerError();
  const m = await activeMembership(db, groupId, userId);
  if (!m || m.role !== "owner") throw new NotOwnerError();
  return g;
}
