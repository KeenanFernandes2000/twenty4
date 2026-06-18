/**
 * users domain (§5 user).
 *
 * Constraint: at least one of email/phone present — enforced with a table CHECK.
 * `username` is case-insensitive unique (citext).
 *
 * NOTE: Better Auth session/account/verification tables are NOT hand-written.
 * They are generated in Slice 3 via `better-auth generate` and live alongside
 * this schema. // Better Auth tables added in Slice 3 via better-auth generate
 */
import { check, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { accountStatusEnum, authProviderEnum } from '../enums.js';
import { citext, createdAt, uuidPk } from './_shared.js';

export const users = pgTable(
  'users',
  {
    id: uuidPk(),
    displayName: text('display_name').notNull(),
    /** Case-insensitive unique handle. */
    username: citext('username').notNull(),
    profilePhotoUrl: text('profile_photo_url'),
    /** Nullable — but a CHECK enforces email OR phone. citext for case-insensitive match. */
    email: citext('email'),
    phone: text('phone'),
    authProvider: authProviderEnum('auth_provider').notNull(),
    accountStatus: accountStatusEnum('account_status').notNull().default('active'),
    /** Per-type notification toggles + per-group mutes + reminder time (PLAN 5.4). */
    notificationPrefs: jsonb('notification_prefs').notNull().default(sql`'{}'::jsonb`),
    privacySettings: jsonb('privacy_settings').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_username_uq').on(t.username),
    // Partial unique: only enforce email uniqueness when present.
    uniqueIndex('users_email_uq').on(t.email).where(sql`${t.email} is not null`),
    uniqueIndex('users_phone_uq').on(t.phone).where(sql`${t.phone} is not null`),
    check('users_email_or_phone', sql`${t.email} is not null or ${t.phone} is not null`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
