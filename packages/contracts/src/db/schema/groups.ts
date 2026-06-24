// Groups schema (M3) — `group`, `group_invite`, `group_member`.
//
// IMPORTANT (M3 learnings, see M3-groups.md §10):
//  - NO DEFERRABLE/PG CHECK to enforce "owner is a member" — PG CHECKs can't be
//    DEFERRABLE and broke BA's multi-step create in v1. The invariant is enforced
//    in the POST /groups create transaction (app layer).
//  - `group_member` uses a COMPOSITE PK(group_id, user_id). This is the
//    concurrency guard: a double-insert from two concurrent joins conflicts on
//    the PK rather than creating two membership rows. The join upserts via
//    ON CONFLICT (group_id, user_id) DO UPDATE.
//  - `group_invite.code` is UNIQUE; the race-safe join targets it with a single
//    conditional UPDATE (... WHERE use_count < max_uses RETURNING).
import { sql } from "drizzle-orm";
import { index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { groupMemberStatus, groupRole, groupStatus } from "./enums.ts";
import { user } from "./auth.ts";

// ── group ──────────────────────────────────────────────────────────────────────
export const group = pgTable("group", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  photoUrl: text("photo_url"),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  status: groupStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── group_invite ───────────────────────────────────────────────────────────────
// `code` UNIQUE + URL-safe (~10-char base62), collision-checked on insert.
// Validity: invalid if revoked_at set OR now() > expires_at OR use_count >= max_uses.
export const groupInvite = pgTable(
  "group_invite",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    groupId: uuid("group_id")
      .notNull()
      .references(() => group.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxUses: integer("max_uses").notNull().default(25),
    useCount: integer("use_count").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("group_invite_code_unique_idx").on(t.code),
    // Partial index on live (un-revoked) invites for the active-invite lookup.
    index("group_invite_group_id_live_idx").on(t.groupId).where(sql`${t.revokedAt} IS NULL`),
  ],
);

// ── group_member ───────────────────────────────────────────────────────────────
// COMPOSITE PK(group_id, user_id) — one membership per (group, user) pair, and
// the concurrency guard for join. `group_member.user_id` index serves GET /groups.
export const groupMember = pgTable(
  "group_member",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => group.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: groupRole("role").notNull().default("member"),
    status: groupMemberStatus("status").notNull().default("active"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("group_member_user_id_idx").on(t.userId),
  ],
);

export type Group = typeof group.$inferSelect;
export type NewGroup = typeof group.$inferInsert;
export type GroupInvite = typeof groupInvite.$inferSelect;
export type GroupMember = typeof groupMember.$inferSelect;
