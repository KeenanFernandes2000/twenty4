/**
 * Health & liveness routes.
 *
 * - GET /healthz  — liveness only, no deps, always 200 (for k8s/orchestrator).
 * - GET /health   — readiness: pings db/redis/storage in parallel.
 *     all up        → 200 { status: 'ok', ... }
 *     some up        → 200 { status: 'degraded', ... } (per-dep booleans)
 *     all down       → 503 { status: 'down', ... }
 */
import type { FastifyPluginAsync } from 'fastify';
import { pingDb } from '../db/index.js';
import { pingRedis } from '../redis/index.js';
import { pingStorage } from '../storage/s3.js';

// Best-effort package version (informational only).
const VERSION = process.env.npm_package_version ?? '0.0.0';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness — never touches external deps.
  app.get('/healthz', async () => ({ status: 'ok' as const }));

  // Readiness — actually pings each dependency.
  app.get('/health', async (_req, reply) => {
    const [dbOk, redisOk, storageOk] = await Promise.all([
      pingDb(),
      pingRedis(),
      pingStorage(),
    ]);

    const deps = { db: dbOk, redis: redisOk, storage: storageOk };
    const upCount = Object.values(deps).filter(Boolean).length;

    const status =
      upCount === 3 ? 'ok' : upCount === 0 ? 'down' : 'degraded';

    // Only 503 when every dependency is down; degraded still serves 200.
    reply.code(status === 'down' ? 503 : 200);

    return {
      status,
      ...deps,
      uptime: Math.round(process.uptime()),
      version: VERSION,
    };
  });
};
