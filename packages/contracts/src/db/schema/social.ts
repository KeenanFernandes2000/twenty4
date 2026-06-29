// Social schema (M8) — `reaction` + `comment`.
//
// The social half of the loop: one replaceable reaction per user per montage and
// soft-deletable comments. Both fan off `montage`; per-montage count / preview /
// list are served by the indexes below.
//
// IMPORTANT (M8 §4):
//  - The `onDelete: "cascade"` FKs to `montage` are DELIBERATE defense-in-depth:
//    M9's montage-row delete (at expiry) must reliably reap reactions/comments
//    even though M9 also runs an explicit cleanup job.
//  - `comment` soft-deletes (status='deleted') in M8 so counts/preview update
//    instantly; physical row removal is M9's cascade at expiry. The length cap is
//    enforced at the route from env (COMMENT_MAX_LENGTH), NOT a DB constraint.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { commentStatus, reactionType } from "./enums.ts";
import { user } from "./auth.ts";
import { montage } from "./montage.ts";

// ── reaction ─────────────────────────────────────────────────────────────────
// One replaceable reaction per (montage, user) — the UNIQUE index is the upsert
// conflict target (ON CONFLICT (montage_id, user_id) DO UPDATE SET type, created_at).
export const reaction = pgTable(
  "reaction",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    montageId: uuid("montage_id")
      .notNull()
      .references(() => montage.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: reactionType("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One reaction per user per montage — the replaceable-upsert conflict target.
    uniqueIndex("reaction_montage_user_unique_idx").on(t.montageId, t.userId),
    // Per-montage count + aggregate.
    index("reaction_montage_id_idx").on(t.montageId),
    // FK index for the block-join filter + cleanup.
    index("reaction_user_id_idx").on(t.userId),
  ],
);

// ── comment ──────────────────────────────────────────────────────────────────
// Soft-deletable (status='deleted') so counts/preview exclude it instantly while
// the row survives for M9's atomic cascade/audit at expiry.
export const comment = pgTable(
  "comment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    montageId: uuid("montage_id")
      .notNull()
      .references(() => montage.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    status: commentStatus("status").notNull().default("active"),
  },
  (t) => [
    // Preview + list + count: only active rows, keyed on (montage, created_at).
    index("comment_montage_created_active_idx").on(t.montageId, t.createdAt).where(sql`status = 'active'`),
    // FK index for the block-join filter + cleanup.
    index("comment_user_id_idx").on(t.userId),
  ],
);

export type Reaction = typeof reaction.$inferSelect;
export type NewReaction = typeof reaction.$inferInsert;
export type Comment = typeof comment.$inferSelect;
export type NewComment = typeof comment.$inferInsert;
