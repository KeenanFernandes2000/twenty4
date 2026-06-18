/**
 * Database client — postgres.js + Drizzle, schema from @twenty4/contracts/db.
 *
 * The Drizzle schema (13 tables + inferred types) is the single source of truth;
 * we import it wholesale so query helpers get full table typing. `pingDb()` runs
 * a trivial `select 1` for the health check; `closeDb()` ends the pool on shutdown.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '@twenty4/contracts/db';
import { env } from '../env.js';

/** Raw postgres.js connection (also used for graceful shutdown). */
export const sqlClient = postgres(env.DATABASE_URL, {
  // Reasonable defaults for an API process; tune in a later slice.
  max: 10,
  // Surface connection errors instead of buffering forever.
  connect_timeout: 10,
});

/** Drizzle ORM instance bound to the contracts schema. */
export const db = drizzle(sqlClient, { schema });

/** Liveness probe for Postgres — returns true if `select 1` succeeds. */
export async function pingDb(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

/** Close the connection pool (graceful shutdown). */
export async function closeDb(): Promise<void> {
  await sqlClient.end({ timeout: 5 });
}
