// Block schema (M3 prerequisite; consumed by M8) — the `block` table.
//
// IMPORTANT (M8 §2/§10):
//  - The block-WRITE API (POST/DELETE /blocks) is M12; M8 only READS these rows
//    to filter the feed + comments in BOTH directions, and the live-stack tests
//    seed them directly. The table + FKs must exist now for that filtering.
//  - The symmetric block-filter runs NOT EXISTS lookups keyed on EITHER side, so
//    both blocker_user_id and blocked_user_id carry their own index.
import { sql } from "drizzle-orm";
import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

// ── block ────────────────────────────────────────────────────────────────────
// One row per directed (blocker, blocked) pair. UNIQUE(blocker, blocked) makes a
// re-block an idempotent no-op; the per-column indexes serve the both-direction
// NOT EXISTS filters in the feed / comment queries.
export const block = pgTable(
  "block",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    blockerUserId: uuid("blocker_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    blockedUserId: uuid("blocked_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("block_blocker_blocked_unique_idx").on(t.blockerUserId, t.blockedUserId),
    index("block_blocker_user_id_idx").on(t.blockerUserId),
    index("block_blocked_user_id_idx").on(t.blockedUserId),
  ],
);

export type Block = typeof block.$inferSelect;
export type NewBlock = typeof block.$inferInsert;
