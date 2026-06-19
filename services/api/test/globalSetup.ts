import Redis from 'ioredis';

/**
 * Vitest globalSetup — runs ONCE before the api suite.
 *
 * The OTP send/verify and invite/render throttles persist their fixed-window
 * counters in Redis (keys `otp:*`, `rl:*`, `twenty4-rl:*`). When the suite is
 * re-run several times inside a 10-minute window those counters accumulate and
 * a `beforeAll` OTP sign-up starts getting 429/401 — a rerun-frequency artifact,
 * not a product bug. Flush just those keys up front so reruns are deterministic.
 * BullMQ (`bull:*`) and app data are left untouched.
 */
export default async function globalSetup(): Promise<void> {
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await redis.connect();
    for (const pattern of ['otp:*', 'rl:*', 'twenty4-rl:*']) {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
    }
  } catch {
    // best-effort: if Redis is unreachable the tests themselves will surface it
  } finally {
    redis.disconnect();
  }
}
