/**
 * @twenty4/contracts — THE SPINE.
 *
 * Single source of truth shared by the API, worker, and mobile app:
 *   - db/        Drizzle pg schema + inferred types (§5)
 *   - dto/       Zod request/response validators (§8)
 *   - edl.ts     the intelligence ↔ renderer EDL contract (§7.1)
 *   - enums.ts   shared enums (pgEnum + Zod, kept consistent)
 *   - analytics.ts  §12 event schemas (NO user content)
 *   - errors.ts  typed error taxonomy
 *
 * `z.infer` gives compile-time types AND runtime validation with no drift.
 *
 * Subpath exports (`@twenty4/contracts/db`, `/dto`, `/edl`, `/enums`,
 * `/analytics`, `/errors`) let consumers import narrowly; this barrel re-exports
 * everything for convenience.
 */
export * from './enums.js';
export * from './edl.js';
export * from './analytics.js';
export * from './errors.js';
export * from './db/index.js';
export * from './dto/index.js';
