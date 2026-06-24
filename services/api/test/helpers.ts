// Shared test helpers — build an app wired to the live-stack DB (5433).
import { buildApp } from "../src/app.ts";
import { createDb, type DbClient } from "../src/db.ts";
import { loadEnvForTest } from "./env.ts";

export function makeDb(): DbClient {
  const env = loadEnvForTest();
  return createDb(env.DATABASE_URL);
}

export async function makeApp(db: DbClient) {
  const env = loadEnvForTest();
  return buildApp({ db, nodeEnv: env.NODE_ENV });
}
