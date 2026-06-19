/**
 * Route-level HTTP rate limiting via @fastify/rate-limit, backed by a dedicated
 * ioredis connection so limits hold across API instances (defense-in-depth on
 * top of the explicit per-identifier counters in lib/rateLimit.ts).
 *
 * Registered globally-DISABLED (`global: false`) so it only throttles routes that
 * opt in via `config.rateLimit`. The error response is shaped into the twenty4
 * `{ error }` envelope with the `rate_limited` code so clients get a consistent
 * 429. `skipOnError: true` means a Redis hiccup degrades to "allow" at THIS layer
 * — the security-critical guarantees (verify-attempt budget, OTP-send cap) live
 * in lib/rateLimit.ts and fail CLOSED there, so this layer staying open is safe.
 */
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { ApiError } from '@twenty4/contracts/errors';

import { env } from '../env.js';

let limiterRedis: Redis | null = null;

/** Dedicated ioredis client tuned for rate limiting (separate from health client). */
function getLimiterRedis(): Redis {
  if (!limiterRedis) {
    limiterRedis = new Redis(env.REDIS_URL, {
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    limiterRedis.on('error', () => {
      /* swallowed — skipOnError degrades gracefully */
    });
  }
  return limiterRedis;
}

/** Register the global (opt-in) rate limiter on the app. */
export async function registerHttpRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: false,
    redis: getLimiterRedis(),
    nameSpace: 'twenty4-rl:',
    skipOnError: true,
    // Use the client IP as the key (trustProxy resolves it correctly).
    keyGenerator: (req) => req.ip,
    // @fastify/rate-limit THROWS the builder's return value (index.js: `throw
    // params.errorResponseBuilder(...)`), so we return an ApiError INSTANCE — the
    // app error handler then maps it to the standard `{ error }` 429 envelope.
    errorResponseBuilder: (_req, context) =>
      new ApiError('rate_limited', 'Too many requests; slow down', {
        retryAfter: Math.ceil(Number(context.ttl) / 1000),
      }) as unknown as Record<string, unknown>,
  });
}

/** Close the limiter's Redis connection on shutdown. */
export async function closeHttpRateLimit(): Promise<void> {
  if (limiterRedis) {
    try {
      await limiterRedis.quit();
    } catch {
      limiterRedis.disconnect();
    }
    limiterRedis = null;
  }
}
