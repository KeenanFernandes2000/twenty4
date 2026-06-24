// @twenty4/contracts — the contracts-as-spine package.
// Single source of truth for DB schema (Drizzle), and later Zod DTOs, the EDL
// schema, the error taxonomy, and the analytics union. M0 ships the DB schema set.
export * as db from "./db/index.ts";
export * from "./db/schema/index.ts";
export * from "./errors/index.ts";
export * from "./env/index.ts";
export * from "./dto/auth.ts";
export * from "./dto/groups.ts";
