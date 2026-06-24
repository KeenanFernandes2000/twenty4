// Postgres enums (pgEnum) live here and are deliberately included in the
// drizzle-kit `schema` glob (drizzle.config.ts) so that adding a pgEnum later
// emits a `CREATE TYPE` in the generated migration. In v1 a missing enums.ts in
// the schema glob meant pgEnums were never emitted — see PHASE1_WORK_RECAP.md §5.
//
// M0 scaffolds the file with one trivial placeholder enum to prove the wiring.
// Real domain enums (montage status, day-window, etc.) land per-milestone from M2.
import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Placeholder enum — proves drizzle-kit emits `CREATE TYPE` from this file.
 * Safe to keep or replace when real enums arrive.
 */
export const scaffoldStatus = pgEnum("scaffold_status", ["ok"]);
