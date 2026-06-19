/**
 * Worker DB client — postgres.js + Drizzle, schema from @twenty4/contracts/db.
 * Mirrors the API's db/index.ts (separate process, separate pool).
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@twenty4/contracts/db';
import { env } from './env.js';

export const sqlClient = postgres(env.DATABASE_URL, {
  max: 5,
  connect_timeout: 10,
});

export const db = drizzle(sqlClient, { schema });

export async function closeDb(): Promise<void> {
  await sqlClient.end({ timeout: 5 });
}
