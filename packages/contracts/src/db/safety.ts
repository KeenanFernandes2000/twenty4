/**
 * safety domain (§5 report, block).
 *
 * report: target is polymorphic (montage|comment|user) so target_id is a bare
 * uuid (no FK — the target may be hard-deleted while the report tombstone lives,
 * §13 retention). May keep a content snapshot for moderation (jsonb, nullable).
 *
 * block: unique(blocker_id, blocked_id); the feed filters BOTH directions.
 */
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  reportReasonEnum,
  reportStatusEnum,
  reportTargetTypeEnum,
} from '../enums.js';
import { createdAt, tsTz, uuidPk } from './_shared.js';
import { users } from './users.js';

/* ---------------------------------- report --------------------------------- */
export const reports = pgTable(
  'report',
  {
    id: uuidPk(),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: reportTargetTypeEnum('target_type').notNull(),
    /** Polymorphic — no FK; target may be purged while report retained (§13). */
    targetId: uuid('target_id').notNull(),
    reason: reportReasonEnum('reason').notNull(),
    status: reportStatusEnum('status').notNull().default('open'),
    /** Optional reporter free-text detail (NOT in analytics; for moderation only). */
    detail: text('detail'),
    /** Free-form note of the admin action taken (nullable). */
    adminAction: text('admin_action'),
    /** The admin who resolved this report (nullable until resolved). No FK (admin may be purged). */
    resolvedByAdminId: uuid('resolved_by_admin_id'),
    /** When the report was resolved (actioned/dismissed). */
    resolvedAt: tsTz('resolved_at'),
    /**
     * Optional moderation snapshot retained past content expiry where legally
     * appropriate (§13, max 7d assumption). NO content unless retention applies.
     */
    contentSnapshot: jsonb('content_snapshot'),
    /**
     * §13 retention: when the `content_snapshot` must be purged (default +7d from
     * creation). A cleanup sweep nulls the snapshot once this passes so reported
     * content is not retained indefinitely. Null ⇒ no snapshot to purge.
     */
    snapshotPurgeAt: tsTz('snapshot_purge_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // Dedup: one OPEN report per (reporter, target). A repeat report by the same
    // reporter against the same target while one is still open is a no-op (the
    // app upserts/no-ops on this index). Partial so resolved reports don't block
    // a later re-report of the same target.
    uniqueIndex('report_reporter_target_open_uq')
      .on(t.reporterId, t.targetType, t.targetId)
      .where(sql`${t.status} = 'open'`),
    // §13 retention: drives the `snapshot-purge-sweep` worker scan that nulls a
    // reported-content snapshot once `snapshot_purge_at` passes. Partial so it only
    // indexes the rows the sweep actually cares about (a snapshot still present).
    index('report_snapshot_purge_due_idx')
      .on(t.snapshotPurgeAt)
      .where(sql`${t.contentSnapshot} is not null`),
  ],
);

export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;

/* ---------------------------------- block ---------------------------------- */
export const blocks = pgTable(
  'block',
  {
    id: uuidPk(),
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('block_blocker_blocked_uq').on(t.blockerId, t.blockedId)],
);

export type Block = typeof blocks.$inferSelect;
export type NewBlock = typeof blocks.$inferInsert;
