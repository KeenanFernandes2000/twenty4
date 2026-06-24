// Drizzle DB client for the worker (postgres.js driver). Mirrors services/api/db.ts.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export interface WorkerDb {
  db: ReturnType<typeof drizzle>;
  sql: ReturnType<typeof postgres>;
}

export function createWorkerDb(databaseUrl: string): WorkerDb {
  const client = postgres(databaseUrl, { max: 5, onnotice: () => {} });
  const db = drizzle(client);
  return { db, sql: client };
}
