/**
 * daily_media_item domain (§5 daily_media_item) — raw uploads / captures.
 *
 * LOAD-BEARING INDEX (§5): composite (user_id, day_bucket, validation_status).
 * This drives "today's valid media for this user" reads on every generate/review.
 */
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  mediaProcessingStatusEnum,
  mediaTypeEnum,
  validationStatusEnum,
} from '../enums.js';
import { createdAt, tsTz, uuidPk } from './_shared.js';
import { users } from './users.js';

export const dailyMediaItems = pgTable(
  'daily_media_item',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The 4am→4am local-day bucket (Q3). RESOLVED AT WRITE TIME and persisted;
     * never recomputed from UTC at read (§6 day window). `date` (no tz).
     */
    dayBucket: date('day_bucket').notNull(),
    mediaType: mediaTypeEnum('media_type').notNull(),
    /** Original upload MIME (e.g. image/jpeg, video/mp4) — drives the worker's
     * EXIF vs ffprobe extraction branch. */
    contentType: text('content_type'),
    /** S3 object key in the raw-media bucket (no public URL). */
    storagePath: text('storage_path').notNull(),
    /**
     * True if captured in-app (the trusted camera path). Auto-valid for the
     * current `day_bucket` (§6); the validation job skips the EXIF hierarchy.
     */
    capturedInApp: boolean('captured_in_app').notNull().default(false),
    /**
     * Device IANA timezone at capture/upload (e.g. `America/New_York`). Drives the
     * authoritative 4am day-window (§6 Q3) AND the worker's "capture time falls in
     * today's bucket" re-check. Persisted so the worker is self-contained.
     */
    deviceTimezone: text('device_timezone'),
    /**
     * Device wall-clock at upload (anti-tamper: compared against server receive
     * time; a large delta sets `device_time_suspicious`, §6).
     */
    deviceTimestamp: tsTz('device_timestamp'),
    /** Resolved capture time (EXIF→media-lib→file; null if none resolved → invalid). */
    originalTimestamp: tsTz('original_timestamp'),
    uploadTimestamp: tsTz('upload_timestamp').notNull().defaultNow(),
    validationStatus: validationStatusEnum('validation_status').notNull().default('pending'),
    processingStatus: mediaProcessingStatusEnum('processing_status')
      .notNull()
      .default('uploaded'),
    /** Anti-tamper: device-reported vs server time delta exceeded threshold (§6). */
    deviceTimeSuspicious: boolean('device_time_suspicious').notNull().default(false),
    /** ms; null for photos. */
    durationMs: integer('duration_ms'),
    /** Bytes (≤200MB/item, §10). bigint to be safe. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /**
     * TOCTOU pin (set on POST /media/:id/complete): the S3 ETag + verified byte
     * size of the object that PASSED the post-upload size/type gate. The worker
     * re-Heads the object BEFORE downloading and refuses to process if the current
     * ETag differs — so a client can't re-PUT a swapped/oversize object to the same
     * key after passing the gate (the presigned PUT stays reusable until its TTL).
     */
    objectEtag: text('object_etag'),
    /** Verified size (bytes) of the object pinned at /complete (matches `objectEtag`). */
    objectSize: bigint('object_size', { mode: 'number' }),
    width: integer('width'),
    height: integer('height'),
    /** Non-PII derived metadata (dims, codec, exif-presence flags) — no content. */
    metadataSummary: jsonb('metadata_summary'),
    /** When the raw item is eligible for purge (publish+60min grace / day close). */
    expiryAt: tsTz('expiry_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // §5 LOAD-BEARING composite index — do not alter ordering.
    index('daily_media_item_user_day_validation_idx').on(
      t.userId,
      t.dayBucket,
      t.validationStatus,
    ),
  ],
);

export type DailyMediaItem = typeof dailyMediaItems.$inferSelect;
export type NewDailyMediaItem = typeof dailyMediaItems.$inferInsert;
