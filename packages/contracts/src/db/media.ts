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
    /** S3 object key in the raw-media bucket (no public URL). */
    storagePath: text('storage_path').notNull(),
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
