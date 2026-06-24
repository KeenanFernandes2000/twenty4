// @twenty4/api — Fastify-on-Bun entrypoint (M1 skeleton).
// Boot sequence (fail-fast): load+guard env → create DB client → verify DB
// (SELECT 1) → build app → listen on 0.0.0.0 → install graceful shutdown.
// buildApp() (in app.ts) stays the testable factory; this file owns process
// lifecycle (env exit codes, DB-verify exit, signal handling).
import { buildApp } from "./app.ts";
import { createDb, verifyDb, type DbClient } from "./db.ts";
import { loadEnv } from "./env.ts";

export { buildApp } from "./app.ts";
export { createDb, verifyDb } from "./db.ts";
export { loadEnv } from "./env.ts";

async function main(): Promise<void> {
  // 1. Fail-fast env (exits non-zero on bad config / prod placeholder secrets).
  const env = loadEnv();

  // 2. DB client.
  const db = createDb(env.DATABASE_URL);

  // 3. DB-verify-on-boot — refuse to start if Postgres is unreachable.
  try {
    await verifyDb(db);
  } catch (err) {
    process.stderr.write(`[db] verify-on-boot failed (SELECT 1) — refusing to boot: ${String(err)}\n`);
    // Best-effort pool close before exiting.
    await db.sql.end({ timeout: 2 }).catch(() => {});
    process.exit(1);
  }

  // 4. Build + listen.
  const app = await buildApp({ db, nodeEnv: env.NODE_ENV });

  installShutdown(app, db);

  try {
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
  } catch (err) {
    app.log.error(err);
    await db.sql.end({ timeout: 2 }).catch(() => {});
    process.exit(1);
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
// On SIGINT/SIGTERM: stop accepting connections (app.close), then close the
// postgres.js pool. Idempotent; bounded by a hard timeout so a hung handle can't
// wedge shutdown. Placeholder hooks for BullMQ/Redis (no jobs yet — M7).
function installShutdown(app: Awaited<ReturnType<typeof buildApp>>, db: DbClient): void {
  let closing = false;
  const SHUTDOWN_TIMEOUT_MS = 10_000;

  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "graceful shutdown started");

    const hardTimer = setTimeout(() => {
      app.log.error("graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Don't let the timer itself keep the process alive.
    if (typeof hardTimer.unref === "function") hardTimer.unref();

    try {
      await app.close(); // stop accepting connections, drain in-flight.
      // Placeholder: BullMQ queues + Redis client close here in M7.
      await db.sql.end({ timeout: 5 }); // close the postgres.js pool.
      clearTimeout(hardTimer);
      app.log.info("graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      clearTimeout(hardTimer);
      process.exit(1);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

// Run only when executed directly (not when imported by tests).
if (import.meta.main) {
  void main();
}
