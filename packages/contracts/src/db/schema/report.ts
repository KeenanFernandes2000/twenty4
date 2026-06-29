// Report schema (M9 read/sweep-only prerequisite; the write API is M12) — the
// `report` table.
//
// IMPORTANT (M9 §2/§5 — the slice-8 PII hole):
//  - The report-WRITE flow (create/resolve) is M12; M9 only needs this table to
//    exist so `snapshot-purge-sweep` can find and strip reported-content snapshots
//    past their retention window (default +7d) — the PII that must be purged. This
//    mirrors how M8's `block` table was added as a read-only prerequisite.
//  - `snapshot_path` (S3 key) + `snapshot_metadata` (content blob) are the PII the
//    sweep purges; `retain_until` is set by the caller to created_at + retention.
//  - `target_id` carries no FK (the reported entity may already be hard-deleted).
//  - `target_type` is plain text (not an enum) for M12 flexibility.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

// ── report ─────────────────────────────────────────────────────────────────────
export const report = pgTable(
  "report",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // 'montage' | 'comment' | 'user' — text, not enum, for M12 flexibility.
    targetType: text("target_type").notNull(),
    // The reported entity's id; NO FK — the target may be hard-deleted (M9 expiry).
    targetId: uuid("target_id").notNull(),
    reason: text("reason").notNull(),
    // The PII the snapshot-purge-sweep strips: S3 key + content blob, nullable.
    snapshotPath: text("snapshot_path"),
    snapshotMetadata: jsonb("snapshot_metadata"),
    // Caller-set created_at + retention window (default +7d via SNAPSHOT_RETENTION_HOURS).
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
    // open | resolved — M12 report→action workflow.
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Drives snapshot-purge-sweep: only rows that still carry a snapshot to purge,
    // keyed on retain_until so the sweep finds past-due ones cheaply.
    index("report_retain_until_idx").on(t.retainUntil).where(sql`snapshot_path IS NOT NULL`),
    // FK index for the reporter cascade + M12 listing.
    index("report_reporter_user_id_idx").on(t.reporterUserId),
  ],
);

export type Report = typeof report.$inferSelect;
export type NewReport = typeof report.$inferInsert;
