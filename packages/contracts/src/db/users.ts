/**
 * users domain (§5 user) — ALSO the Better Auth `user` model (Slice 3).
 *
 * ONE source of user truth: Better Auth's drizzle adapter maps onto THIS table
 * (`user.modelName = 'users'`) with field remaps:
 *   - Better Auth `name`  → `display_name`
 *   - Better Auth `image` → `profile_photo_url`
 *   - Better Auth `emailVerified` → `email_verified`
 *   - phoneNumber plugin `phoneNumber` → `phone`, `phoneNumberVerified` → `phone_number_verified`
 *
 * Columns Better Auth strictly needs that we added here: `email_verified`,
 * `updated_at`, `phone_number_verified`. Everything else maps onto existing cols.
 *
 * Because Better Auth inserts the user row at OTP-verify time (BEFORE profile
 * setup), `display_name`/`username` are NULLABLE and `auth_provider` carries a
 * DB default — the profile-setup PATCH fills the real handle later (`needsProfile`).
 * The session/account/verification + OTP plugin tables live in `./auth.ts`.
 */
import { boolean, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { accountStatusEnum, authProviderEnum } from '../enums.js';
import { citext, createdAt, updatedAt, uuidPk } from './_shared.js';

export const users = pgTable(
  'users',
  {
    id: uuidPk(),
    /** Better Auth `name`. Nullable: set at profile-setup (1.4), not at OTP-verify. */
    displayName: text('display_name'),
    /** Case-insensitive unique handle. Nullable until profile-setup. */
    username: citext('username'),
    /** Better Auth `image`. */
    profilePhotoUrl: text('profile_photo_url'),
    /**
     * citext for case-insensitive match. Nullable: a user may have only a phone.
     * The "email OR phone present" invariant is enforced at the API layer (every
     * sign-in supplies an identifier) rather than a DB CHECK — Better Auth creates
     * the user row in multiple steps (phone is set after the initial insert), which
     * a create-time CHECK cannot accommodate. // invariant moved to app layer (Slice 3)
     */
    email: citext('email'),
    /** Better Auth `emailVerified`. */
    emailVerified: boolean('email_verified').notNull().default(false),
    /** phoneNumber plugin `phoneNumber`. */
    phone: text('phone'),
    /** phoneNumber plugin `phoneNumberVerified`. */
    phoneNumberVerified: boolean('phone_number_verified').notNull().default(false),
    /** DB default lets Better Auth insert the row pre-profile; refined per flow. */
    authProvider: authProviderEnum('auth_provider').notNull().default('email'),
    accountStatus: accountStatusEnum('account_status').notNull().default('active'),
    /**
     * Moderation/ops admin flag (Slice 8). Seeded from the `ADMIN_EMAILS`
     * allowlist on sign-in (and settable by a one-off seed). The `requireAdmin`
     * preHandler gates every `/admin/*` route on a valid session AND this flag;
     * a non-admin session is 403'd (and the attempt audited). NOT user-settable
     * through any public endpoint.
     */
    isAdmin: boolean('is_admin').notNull().default(false),
    /** Per-type notification toggles + per-group mutes + reminder time (PLAN 5.4). */
    notificationPrefs: jsonb('notification_prefs').notNull().default(sql`'{}'::jsonb`),
    privacySettings: jsonb('privacy_settings').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    /** Better Auth `updatedAt` — required by the adapter. */
    updatedAt: updatedAt(),
  },
  (t) => [
    // Partial unique: only enforce username uniqueness once chosen.
    uniqueIndex('users_username_uq').on(t.username).where(sql`${t.username} is not null`),
    // Partial unique: only enforce email uniqueness when present.
    uniqueIndex('users_email_uq').on(t.email).where(sql`${t.email} is not null`),
    uniqueIndex('users_phone_uq').on(t.phone).where(sql`${t.phone} is not null`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
