// is_admin seeding from ADMIN_EMAILS (comma-separated, case-insensitive).
//  - parseAdminEmails: env string → normalized Set.
//  - isAdminEmail: membership test for the account-create path.
//  - reconcileAdmins: boot pass — set is_admin=true for users whose email is in
//    the list (and, defensively, false for any stale admin no longer listed).
import { inArray, notInArray, sql } from "drizzle-orm";
import { user as userTable } from "@twenty4/contracts/db";
import type { DbClient } from "../db.ts";

export function parseAdminEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export function isAdminEmail(admins: Set<string>, email: string | null | undefined): boolean {
  if (!email) return false;
  return admins.has(email.trim().toLowerCase());
}

// Boot reconciliation: make the DB match ADMIN_EMAILS exactly.
export async function reconcileAdmins(db: DbClient, admins: Set<string>): Promise<void> {
  const list = [...admins];
  if (list.length === 0) {
    // No admins configured → demote any lingering admins.
    await db.db.update(userTable).set({ isAdmin: false }).where(sql`${userTable.isAdmin} = true`);
    return;
  }
  // email is citext, so equality is case-insensitive; compare lowercased anyway.
  await db.db
    .update(userTable)
    .set({ isAdmin: true })
    .where(inArray(sql`lower(${userTable.email})`, list));
  await db.db
    .update(userTable)
    .set({ isAdmin: false })
    .where(notInArray(sql`lower(coalesce(${userTable.email}, ''))`, list));
}
