/**
 * Drizzle schema barrel — the single source of truth for the twenty4 DB (§5).
 *
 * `drizzle.config.ts` points `schema` here; this is also what consumers import
 * as `@twenty4/contracts/db`. Every table + its $inferSelect/$inferInsert types
 * are re-exported.
 *
 * pgEnums are defined in `../enums.ts` and referenced by columns here; they are
 * surfaced to drizzle-kit transitively through the table column definitions.
 *
 * // Better Auth tables (sessions/accounts/verification) added in Slice 3 via
 * // `better-auth generate` — NOT hand-written here.
 */
export * from './users.js';
export * from './groups.js';
export * from './media.js';
export * from './montage.js';
export * from './social.js';
export * from './safety.js';
export * from './system.js';

// NOTE: pgEnums are defined in `../enums.ts` and reach drizzle-kit transitively
// via the table column references above (drizzle-kit serializes the schema by
// following column types). They are NOT re-exported here to avoid a duplicate-
// export collision with the top-level barrel, which owns all enum exports.
// If a future drizzle-kit version fails to pick up an unreferenced enum, add an
// explicit `export { xEnum } from '../enums.js'` here for that enum only.
