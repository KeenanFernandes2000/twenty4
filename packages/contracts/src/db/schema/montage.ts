// Montage schema (M7) — `montage` + `montage_group_visibility`.
//
// The montage row carries the full render record: the persisted `edl` jsonb, the
// `source_media_ids` it was built from, `theme`/`music_id`, the status machine,
// the S3 paths (video + thumbnail), and the day_bucket it belongs to.
//
// IMPORTANT (M7 §4):
//  - One render fans out to many groups via `montage_group_visibility` (PK on
//    (montage_id, group_id)) — drives one-render→many-groups + per-group feed
//    authz (M8). "One recap per user/group/day" is an app-layer check on publish
//    (so regenerate-before-publish stays free), NOT a DB unique constraint.
//  - DELIBERATE PG CHECK `montage_published_expiry_check`: a published montage
//    MUST carry an expiry_at. The codebase normally avoids PG CHECKs (the M3/BA
//    deferrable-constraint lesson), but this montage-only invariant is isolated
//    and milestone-required.
//  - Partial index on (status, expiry_at) WHERE status='published' drives the
//    M8 feed + M9 expiry sweeps.
import { sql } from "drizzle-orm";
import { check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { montageStatus } from "./enums.ts";
import { user } from "./auth.ts";
import { group } from "./groups.ts";

// ── montage ──────────────────────────────────────────────────────────────────
export const montage = pgTable(
  "montage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // The persisted 4am-window local day (DATE) this recap belongs to.
    dayBucket: date("day_bucket").notNull(),
    // S3 object keys — null until the render writes them (draft_ready).
    videoPath: text("video_path"),
    thumbnailPath: text("thumbnail_path"),
    durationMs: integer("duration_ms"),
    status: montageStatus("status").notNull().default("not_generated"),
    // Stored as text (the pgEnum exists only for a documented CREATE TYPE).
    theme: text("theme").notNull(),
    musicId: text("music_id").notNull(),
    // The persisted strict EDL (the render's source of truth).
    edl: jsonb("edl"),
    // The exact media set the EDL was built from.
    sourceMediaIds: uuid("source_media_ids").array().notNull().default(sql`'{}'::uuid[]`),
    // BullMQ jobId (montage-<id>; never contains ':' — recap §8.10).
    renderJobId: text("render_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    expiryAt: timestamp("expiry_at", { withTimezone: true }),
  },
  (t) => [
    // Published ⇒ expiry_at set (the as-built invariant, M7 §4).
    check("montage_published_expiry_check", sql`status <> 'published' OR expiry_at IS NOT NULL`),
    // Feed (M8) + expiry sweep (M9): only published rows, keyed on (status, expiry).
    index("montage_published_status_expiry_idx").on(t.status, t.expiryAt).where(sql`status = 'published'`),
    // Per-day lookup for the owner's recap.
    index("montage_user_day_idx").on(t.userId, t.dayBucket),
  ],
);

// ── montage_group_visibility ─────────────────────────────────────────────────
// One row per (montage, group) the recap is published into. Composite PK makes
// re-publish to the same set an idempotent no-op (ON CONFLICT DO NOTHING).
export const montageGroupVisibility = pgTable(
  "montage_group_visibility",
  {
    montageId: uuid("montage_id")
      .notNull()
      .references(() => montage.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => group.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.montageId, t.groupId] })],
);

export type Montage = typeof montage.$inferSelect;
export type NewMontage = typeof montage.$inferInsert;
export type MontageGroupVisibility = typeof montageGroupVisibility.$inferSelect;
export type NewMontageGroupVisibility = typeof montageGroupVisibility.$inferInsert;
