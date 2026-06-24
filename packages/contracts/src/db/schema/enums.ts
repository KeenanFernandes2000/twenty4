// Postgres enums (pgEnum) live here and are deliberately included in the
// drizzle-kit `schema` glob (drizzle.config.ts) so that adding a pgEnum later
// emits a `CREATE TYPE` in the generated migration. In v1 a missing enums.ts in
// the schema glob meant pgEnums were never emitted — see PHASE1_WORK_RECAP.md §5.
//
// M0 scaffolds the file with one trivial placeholder enum to prove the wiring.
// Real domain enums land per-milestone from M2.
import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Placeholder enum from M0 — proves drizzle-kit emits `CREATE TYPE` from this file.
 * Kept (not dropped) so migration generation produces a clean additive diff; it
 * already exists in the live DB from 0000_init.
 */
export const scaffoldStatus = pgEnum("scaffold_status", ["ok"]);

/**
 * How a user first authenticated / which provider owns the account.
 * Social providers (apple, google) are interface-stubbed in P1, wired in M14.
 */
export const authProvider = pgEnum("auth_provider", ["phone", "email", "apple", "google"]);

/**
 * Account lifecycle state. The M2 session-create gate only mints a session for
 * `active`; suspended/banned/deleted are rejected with a 403 envelope code.
 */
export const accountStatus = pgEnum("account_status", ["active", "suspended", "banned", "deleted"]);
