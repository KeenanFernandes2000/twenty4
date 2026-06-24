// Invite rate limiting (M3) — per-user fixed-window counters in Redis, reusing
// the M2 OTP-counter pattern. Caps are env-configurable (INVITE_CREATE_CAP /
// INVITE_JOIN_CAP / INVITE_WINDOW_SEC) so CI can set low caps for deterministic
// 429 tests (the §5 OTP-cap learning applied to invites).
import { RateLimitedError } from "@twenty4/contracts";
import type { RedisClient } from "../redis.ts";

export interface InviteRateLimitConfig {
  createCap: number;
  joinCap: number;
  windowSec: number;
}

const CREATE_PREFIX = "invite:rl:create:";
const JOIN_PREFIX = "invite:rl:join:";

// All invite rate-limit key globs, in ONE place — tests flush exactly these.
export const INVITE_REDIS_KEY_GLOBS = ["invite:*"] as const;

export interface InviteRateLimiter {
  // Throttle invite create per (owner) user. Throws RateLimitedError (429).
  checkCreate(userId: string): Promise<void>;
  // Throttle invite join per (caller) user. Throws RateLimitedError (429).
  checkJoin(userId: string): Promise<void>;
}

// Increment a fixed-window counter; set the TTL on first hit. Returns the count.
async function bump(redis: RedisClient, key: string, windowSec: number): Promise<number> {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  return n;
}

export function createInviteRateLimiter(redis: RedisClient, cfg: InviteRateLimitConfig): InviteRateLimiter {
  return {
    async checkCreate(userId) {
      const n = await bump(redis, `${CREATE_PREFIX}${userId}`, cfg.windowSec);
      if (n > cfg.createCap) throw new RateLimitedError("Too many invites created; slow down");
    },
    async checkJoin(userId) {
      const n = await bump(redis, `${JOIN_PREFIX}${userId}`, cfg.windowSec);
      if (n > cfg.joinCap) throw new RateLimitedError("Too many join attempts; slow down");
    },
  };
}
