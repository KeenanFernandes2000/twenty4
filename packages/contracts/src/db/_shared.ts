/**
 * Shared column types & helpers for the Drizzle pg schema.
 *
 * Conventions (§5):
 *   - UUID v4 PKs, default `gen_random_uuid()` (requires the `pgcrypto`
 *     extension — the first migration must `CREATE EXTENSION IF NOT EXISTS pgcrypto`).
 *     gen_random_uuid() is also built-in from Postgres 13+; pgcrypto guarantees it
 *     across managed providers. The migration setup is owned by infra/migrations.
 *   - all timestamps `timestamptz` (UTC), via the shared `tsTz` helper.
 *   - case-insensitive text (email/username) via a custom `citext` type
 *     (requires `CREATE EXTENSION IF NOT EXISTS citext`).
 */
import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Postgres `citext` — case-insensitive text. Used for `username` (and any case-
 * insensitive unique). Requires the `citext` extension to be installed (handled
 * in the first migration).
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/** UUID v4 PK column with `gen_random_uuid()` default. */
export const uuidPk = () => uuid('id').primaryKey().defaultRandom();

/** A non-null `timestamptz` column with a name. */
export const tsTz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

/** `created_at timestamptz NOT NULL DEFAULT now()`. */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow();

/**
 * `updated_at timestamptz NOT NULL DEFAULT now()`, auto-bumped on update.
 * Required by Better Auth's adapter on its managed models (user/session/...).
 */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Re-export so domain files can build partial-index `.where(...)` predicates. */
export { sql };
