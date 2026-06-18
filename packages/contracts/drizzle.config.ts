import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration for the twenty4 schema.
 *
 * The schema is the single source of truth (`./src/db/index.ts`). Generated SQL
 * migrations are checked into the repo under `infra/migrations` and applied by
 * the API/worker at deploy time — drizzle-kit is NOT run in CI against a live DB
 * here; the orchestrator runs `drizzle-kit generate` to produce the checked-in SQL.
 */
export default defineConfig({
  dialect: 'postgresql',
  // Include enums.ts so drizzle-kit registers the pgEnums (emits CREATE TYPE);
  // the db tables reference these same pgEnum instances.
  schema: ['./src/db/index.ts', './src/enums.ts'],
  out: '../../infra/migrations',
  strict: true,
  verbose: true,
  // Author tables/columns in snake_case in SQL while using camelCase in TS where convenient.
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
