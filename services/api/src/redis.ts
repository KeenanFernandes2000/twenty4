// Shared ioredis client for @twenty4/api — OTP dev store + rate-limit counters.
// One connection per process; closed on graceful shutdown.
import Redis from "ioredis";

export type RedisClient = Redis;

export function createRedis(redisUrl: string): RedisClient {
  // maxRetriesPerRequest: null lets commands queue while (re)connecting rather
  // than throwing immediately on a blip; lazyConnect keeps construction cheap.
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
