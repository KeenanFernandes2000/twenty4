// Drizzle DB client (postgres.js driver) for @twenty4/api.
// One physical drizzle-orm (deduped in M0 via the kysely devDep on contracts).
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";

export type Db = ReturnType<typeof createDb>;

export interface DbClient {
  db: ReturnType<typeof drizzle>;
  // The raw postgres.js connection — exposed so graceful shutdown can close it.
  sql: ReturnType<typeof postgres>;
}

// Create the postgres.js pool + drizzle wrapper from DATABASE_URL.
export function createDb(databaseUrl: string): DbClient {
  // Keep the pool small for the scaffold; tune later. connect_timeout bounds the
  // DB-verify-on-boot so an unreachable DB fails fast (no long hang before exit).
  const connectTimeout = Number(process.env.DB_CONNECT_TIMEOUT ?? 5);
  const client = postgres(databaseUrl, { max: 10, connect_timeout: connectTimeout, onnotice: () => {} });
  const db = drizzle(client);
  return { db, sql: client };
}

// DB-verify-on-boot: run SELECT 1. Throws on failure so the caller can fail fast.
export async function verifyDb(client: DbClient): Promise<void> {
  await client.db.execute(sql`select 1`);
}
