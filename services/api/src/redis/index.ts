/**
 * Redis client — ioredis (lazyConnect).
 *
 * Used later by BullMQ producers and rate limiting. `lazyConnect` keeps the
 * process bootable without Redis; `pingRedis()` connects on first call for the
 * health check. `closeRedis()` quits the connection on shutdown.
 */
import { Redis } from 'ioredis';
import { env } from '../env.js';

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  // Don't queue commands forever if Redis is unreachable — fail health fast.
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

// Avoid unhandled 'error' events crashing the process when Redis is down.
redis.on('error', () => {
  /* swallowed — surfaced via pingRedis() in the health check */
});

/** Liveness probe for Redis — returns true if PING succeeds. */
export async function pingRedis(): Promise<boolean> {
  try {
    if (redis.status === 'wait' || redis.status === 'close' || redis.status === 'end') {
      await redis.connect();
    }
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/** Close the Redis connection (graceful shutdown). */
export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
