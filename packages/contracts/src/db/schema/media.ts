// Media schema (M4) — `daily_media_item`.
//
// One row per uploaded media item. The row is created at POST /media (init) with
// processing_status=uploaded / validation_status=pending, the day_bucket PERSISTED
// (4am→4am device-local; NEVER recomputed at read — M4 §6/A10), then advanced by
// /complete (HeadObject gate + ETag pin) and the validate-media worker job.
//
// IMPORTANT (M4 learnings):
//  - `day_bucket` is a DATE persisted at init from the device tz; reads query it
//    directly (GET /media/today) and never recompute from UTC.
//  - `metadata_summary` jsonb is the catch-all the validate job writes to: the
//    resolved-timestamp source, device-clock delta + anti-tamper flag, the loud
//    `freshnessNotProven` flag (A14), the pinned ETag (TOCTOU), and the declared-
//    vs-actual content-type/size from the /complete HeadObject gate.
//  - No PG CHECK constraints (the M3/v1 lesson: PG CHECKs can't be DEFERRABLE).
import { sql } from "drizzle-orm";
import { bigint, date, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { mediaType, processingStatus, validationStatus } from "./enums.ts";
import { user } from "./auth.ts";

export const dailyMediaItem = pgTable(
  "daily_media_item",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Persisted 4am-window local day (DATE) — computed at init, never recomputed.
    dayBucket: date("day_bucket").notNull(),
    mediaType: mediaType("media_type").notNull(),
    // S3 object key within the raw bucket, e.g. media/<userId>/<id>.
    storagePath: text("storage_path").notNull(),
    // S3 object key in the thumbnails bucket for a video poster frame (M7 §12).
    // Nullable: photos and not-yet-processed videos have none; the validate-media
    // worker populates it for videos.
    thumbnailPath: text("thumbnail_path"),
    // Resolved capture time (validation hierarchy) — nullable until the worker runs.
    originalTimestamp: timestamp("original_timestamp", { withTimezone: true }),
    uploadTimestamp: timestamp("upload_timestamp", { withTimezone: true }).notNull().defaultNow(),
    validationStatus: validationStatus("validation_status").notNull().default("pending"),
    processingStatus: processingStatus("processing_status").notNull().default("uploaded"),
    // Video duration in ms (nullable; photos have none).
    durationMs: integer("duration_ms"),
    // jsonb catch-all (see header). Defaults to {}.
    metadataSummary: jsonb("metadata_summary").notNull().default(sql`'{}'::jsonb`),
    // Declared byte size from init (the actual gated size lives in metadata_summary).
    byteSize: bigint("byte_size", { mode: "number" }),
    expiryAt: timestamp("expiry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The hot path: caller's items for a day_bucket filtered by validation verdict.
    index("daily_media_item_user_day_validation_idx").on(t.userId, t.dayBucket, t.validationStatus),
  ],
);

export type DailyMediaItem = typeof dailyMediaItem.$inferSelect;
export type NewDailyMediaItem = typeof dailyMediaItem.$inferInsert;
