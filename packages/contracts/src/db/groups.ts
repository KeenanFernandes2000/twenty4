/**
 * groups domain (§5 group, group_invite, group_member).
 */
import { integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  groupMemberRoleEnum,
  groupMemberStatusEnum,
  groupStatusEnum,
} from '../enums.js';
import { createdAt, tsTz, uuidPk } from './_shared.js';
import { users } from './users.js';

/* ----------------------------------- group --------------------------------- */
export const groups = pgTable('groups', {
  id: uuidPk(),
  name: text('name').notNull(),
  photoUrl: text('photo_url'),
  // owner deletion cascades the group (account purge §6).
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: groupStatusEnum('status').notNull().default('active'),
  createdAt: createdAt(),
});

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;

/* ------------------------------- group_invite ------------------------------ */
export const groupInvites = pgTable(
  'group_invites',
  {
    id: uuidPk(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    /** Short, URL-safe, unique invite code (deep link `twenty4://invite/{code}`). */
    code: text('code').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: tsTz('expires_at').notNull(),
    /** Use cap (Q11), default 25. */
    maxUses: integer('max_uses').notNull().default(25),
    useCount: integer('use_count').notNull().default(0),
    /** Set when revoked; an invite is invalid if revoked, expired, or used up. */
    revokedAt: tsTz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('group_invites_code_uq').on(t.code)],
);

export type GroupInvite = typeof groupInvites.$inferSelect;
export type NewGroupInvite = typeof groupInvites.$inferInsert;

/* ------------------------------- group_member ------------------------------ */
export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: groupMemberRoleEnum('role').notNull().default('member'),
    joinedAt: tsTz('joined_at').notNull().defaultNow(),
    status: groupMemberStatusEnum('status').notNull().default('active'),
  },
  // Composite PK(group_id, user_id) per §5.
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export type GroupMember = typeof groupMembers.$inferSelect;
export type NewGroupMember = typeof groupMembers.$inferInsert;
