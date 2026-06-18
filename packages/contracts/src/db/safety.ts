/**
 * safety domain (§5 report, block).
 *
 * report: target is polymorphic (montage|comment|user) so target_id is a bare
 * uuid (no FK — the target may be hard-deleted while the report tombstone lives,
 * §13 retention). May keep a content snapshot for moderation (jsonb, nullable).
 *
 * block: unique(blocker_id, blocked_id); the feed filters BOTH directions.
 */
import { jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  reportReasonEnum,
  reportStatusEnum,
  reportTargetTypeEnum,
} from '../enums.js';
import { createdAt, uuidPk } from './_shared.js';
import { users } from './users.js';

/* ---------------------------------- report --------------------------------- */
export const reports = pgTable('report', {
  id: uuidPk(),
  reporterId: uuid('reporter_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  targetType: reportTargetTypeEnum('target_type').notNull(),
  /** Polymorphic — no FK; target may be purged while report retained (§13). */
  targetId: uuid('target_id').notNull(),
  reason: reportReasonEnum('reason').notNull(),
  status: reportStatusEnum('status').notNull().default('open'),
  /** Free-form note of the admin action taken (nullable). */
  adminAction: text('admin_action'),
  /**
   * Optional moderation snapshot retained past content expiry where legally
   * appropriate (§13, max 7d assumption). NO content unless retention applies.
   */
  contentSnapshot: jsonb('content_snapshot'),
  createdAt: createdAt(),
});

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
