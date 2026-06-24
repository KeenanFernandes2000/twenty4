// Auth schema — the `user` table + Better Auth's `session` / `account` /
// `verification` tables, plus `audit_log`. This is the single source of truth
// the Drizzle adapter binds to in services/api.
//
// IMPORTANT (v1 lessons, see PHASE1_WORK_RECAP.md §5):
//  - BA's drizzle adapter maps by Drizzle PROPERTY names, not SQL columns. We
//    name the TS properties to match BA's expectations (`emailVerified`,
//    `userId`, `expiresAt`, …) and let the column() arg carry snake_case.
//  - `display_name` / `username` are NULLABLE — BA's multi-step create inserts a
//    user row before our profile fields exist.
//  - NO email-or-phone CHECK (PG CHECKs can't be DEFERRABLE with BA's multi-step
//    create); the invariant is enforced at the app layer in POST /users.
//  - `id` is PG-generated (gen_random_uuid()); BA's advanced.generateId returns
//    false for user/users so PG owns the uuid.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";
import { accountStatus, authProvider } from "./enums.ts";

// citext column helper — case-insensitive text (emails / usernames). The citext
// extension is created in 0000_init.
const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

// ── user ─────────────────────────────────────────────────────────────────────
// PG-generated uuid PK. Profile fields nullable for BA's multi-step create.
export const user = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // BA writes `name`/`email`/`emailVerified`/`image` on the user during create;
    // we map name -> display_name, image -> profile_photo_url in the BA config.
    displayName: text("display_name"),
    username: citext("username"),
    email: citext("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    phone: text("phone"),
    phoneNumberVerified: boolean("phone_number_verified").notNull().default(false),
    profilePhotoUrl: text("profile_photo_url"),
    authProvider: authProvider("auth_provider").notNull().default("email"),
    accountStatus: accountStatus("account_status").notNull().default("active"),
    isAdmin: boolean("is_admin").notNull().default(false),
    // Canonical (server-anchored) IANA timezone for day_bucket resolution (M4
    // HIGH-3). Set on the FIRST media init if unset; bucketing always uses THIS
    // value, never the raw per-request deviceTimezone, so a client cannot multiply
    // their daily cap by rotating zones. Nullable until first set.
    timezone: text("timezone"),
    notificationPrefs: jsonb("notification_prefs").notNull().default(sql`'{}'::jsonb`),
    privacySettings: jsonb("privacy_settings").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial unique index on username (citext) WHERE not null — usernames are
    // optional but unique when present.
    uniqueIndex("user_username_unique_idx").on(t.username).where(sql`${t.username} IS NOT NULL`),
    // Unique email when present (BA requires unique email for the email channel).
    uniqueIndex("user_email_unique_idx").on(t.email).where(sql`${t.email} IS NOT NULL`),
    // Unique phone when present.
    uniqueIndex("user_phone_unique_idx").on(t.phone).where(sql`${t.phone} IS NOT NULL`),
  ],
);

// ── session ──────────────────────────────────────────────────────────────────
// PG-stored, revocable. BA owns the row; we never special-case generateId here
// (BA mints the session id/token).
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

// ── account ──────────────────────────────────────────────────────────────────
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

// ── verification ─────────────────────────────────────────────────────────────
// BA's OTP/verification store. Phone OTP is plaintext-at-rest here (accepted P1
// limit, BA 1.6); email OTP is hashed by BA.
export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ── audit_log ────────────────────────────────────────────────────────────────
// One row per admin (requireAdmin-guarded) action.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_actor_id_idx").on(t.actorId)],
);

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Session = typeof session.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
