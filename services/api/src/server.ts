/**
 * Server entrypoint — build the app, listen, and shut down gracefully.
 *
 * On SIGINT/SIGTERM we close Fastify (stop accepting), then drain external
 * resources (Redis, Postgres, S3) and exit. A second signal forces exit.
 */
import { buildApp } from './app.js';
import { env } from './env.js';
import { closeDb } from './db/index.js';
import { closeRedis } from './redis/index.js';
import { closeStorage } from './storage/s3.js';
import { closeQueues } from './queue/producers.js';

async function main(): Promise<void> {
  const app = await buildApp();

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`twenty4 api listening on http://${env.HOST}:${env.PORT}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      app.log.warn(`${signal} received again — forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    app.log.info(`${signal} received — shutting down gracefully`);

    try {
      await app.close(); // stop accepting connections, run onClose hooks
      await Promise.allSettled([closeQueues(), closeRedis(), closeDb()]);
      closeStorage();
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[twenty4/api] fatal startup error:', err);
  process.exit(1);
});
