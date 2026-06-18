/**
 * social domain (§5 reaction, comment).
 *
 * Both CASCADE from montage (§6: "live and die with their montage").
 * reaction: unique(montage_id, user_id) → one reaction per user per montage (replaceable upsert).
 */
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { commentStatusEnum, reactionTypeEnum } from '../enums.js';
import { createdAt, uuidPk } from './_shared.js';
import { montages } from './montage.js';
import { users } from './users.js';

/* --------------------------------- reaction -------------------------------- */
export const reactions = pgTable(
  'reaction',
  {
    id: uuidPk(),
    montageId: uuid('montage_id')
      .notNull()
      .references(() => montages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: reactionTypeEnum('type').notNull(),
    createdAt: createdAt(),
  },
  // One reaction per user per montage (§5) — upsert target.
  (t) => [uniqueIndex('reaction_montage_user_uq').on(t.montageId, t.userId)],
);

export type Reaction = typeof reactions.$inferSelect;
export type NewReaction = typeof reactions.$inferInsert;

/* --------------------------------- comment --------------------------------- */
export const comments = pgTable('comment', {
  id: uuidPk(),
  montageId: uuid('montage_id')
    .notNull()
    .references(() => montages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  status: commentStatusEnum('status').notNull().default('active'),
  createdAt: createdAt(),
});

export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
