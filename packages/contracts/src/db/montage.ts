/**
 * montage domain (§5 montage, montage_group_visibility).
 *
 * LOAD-BEARING PARTIAL INDEX (§5): on (status, expiry_at) WHERE status = 'published'.
 * Drives the feed read AND the expiry sweep (find published montages past expiry).
 * Implemented with Drizzle `.where(sql\`...\`)` on the index.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { montageStatusEnum, themeEnum } from '../enums.js';
import type { Edl } from '../edl.js';
import { createdAt, tsTz, uuidPk } from './_shared.js';
import { groups } from './groups.js';
import { users } from './users.js';

export const montages = pgTable(
  'montage',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dayBucket: date('day_bucket').notNull(),
    /** S3 key, null until rendered. */
    videoPath: text('video_path'),
    thumbnailPath: text('thumbnail_path'),
    durationMs: integer('duration_ms'),
    status: montageStatusEnum('status').notNull().default('not_generated'),
    /** Resolved theme (concrete, not `Random`). */
    theme: themeEnum('theme'),
    musicId: text('music_id'),
    /**
     * The EXACT daily_media_item ids the user selected at generate time (§2.5
     * review-screen selection). The render job loads PRECISELY these (re-filtered
     * by owner+valid+today+not-deleted as a safety net) instead of ALL the day's
     * valid media — honoring the user's curation. Persisted on the row so a later
     * regenerate stays consistent with the original selection. Null only on legacy
     * rows / a row created before a selection was recorded.
     */
    sourceMediaIds: uuid('source_media_ids').array(),
    renderJobId: text('render_job_id'),
    /** The EDL the intelligence emitted & the renderer consumed (jsonb). */
    edl: jsonb('edl').$type<Edl>(),
    /**
     * Replace flow (§6 Q2): when a replacement montage is PUBLISHED, the prior
     * montage is marked `superseded` — its `supersededBy` points at the new id and
     * its status moves to a terminal `deleted_by_user`. Full cascade delete of the
     * old render + its social is Slice 7 (here we mark/supersede + enqueue cleanup).
     * Nullable; only set on a montage that has been replaced.
     */
    supersededBy: uuid('superseded_by'),
    /** Non-fatal render failure detail (non-PII) for the §7.4 failed state / admin. */
    renderError: text('render_error'),
    createdAt: createdAt(),
    publishedAt: tsTz('published_at'),
    /** = published_at + 24h. */
    expiryAt: tsTz('expiry_at'),
  },
  (t) => [
    // §5 LOAD-BEARING partial index — drives feed + the published-expiry sweep clause.
    index('montage_published_status_expiry_idx')
      .on(t.status, t.expiryAt)
      .where(sql`${t.status} = 'published'`),
    index('montage_user_day_idx').on(t.userId, t.dayBucket),
    // Slice 7 BACKSTOP (Fix 1): drives the content-reclamation sweep's terminal-status
    // clause — terminal rows (deleted_by_user / removed_by_admin) that STILL hold S3
    // content (a superseded/removed montage whose content-delete job was lost). Partial
    // so it indexes ONLY the tiny set of content-bearing terminal rows — a normal
    // tombstoned/expired row (no paths) is excluded, keeping the scan trivially small.
    index('montage_reclaim_idx')
      .on(t.status)
      .where(
        sql`${t.status} in ('deleted_by_user', 'removed_by_admin') and (${t.videoPath} is not null or ${t.thumbnailPath} is not null)`,
      ),
    // Slice 7 INVARIANT (Fix 4): a published montage MUST have an expiry_at, so the
    // 24h-expiry sweep can never miss it (a NULL-expiry published row was a latent
    // forever-leak). The DB rejects inserting/flipping a published row without one.
    check(
      'montage_published_has_expiry',
      sql`${t.status} <> 'published' or ${t.expiryAt} is not null`,
    ),
  ],
);

export type Montage = typeof montages.$inferSelect;
export type NewMontage = typeof montages.$inferInsert;

/* ------------------------- montage_group_visibility ------------------------ */
/**
 * One render → many groups (Q1). The authz join for the feed: a montage is
 * visible to a user iff a row here links it to a group the user is an active
 * member of (minus block relationships). Uniqueness via composite PK.
 */
export const montageGroupVisibility = pgTable(
  'montage_group_visibility',
  {
    montageId: uuid('montage_id')
      .notNull()
      .references(() => montages.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.montageId, t.groupId] }),
    // Reverse lookup: "published montages visible to this group" (feed by group).
    index('montage_group_visibility_group_idx').on(t.groupId),
  ],
);

export type MontageGroupVisibility = typeof montageGroupVisibility.$inferSelect;
export type NewMontageGroupVisibility = typeof montageGroupVisibility.$inferInsert;
