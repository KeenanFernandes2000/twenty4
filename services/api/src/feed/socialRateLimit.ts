// Social rate limiting (M8 §11) — per-user fixed-window counters in Redis, mirroring
// the M3 invite limiter (itself the M2 OTP-counter pattern). Caps are env-configurable
// (COMMENT_CREATE_CAP / COMMENT_WINDOW_SEC / REACTION_SET_CAP / REACTION_WINDOW_SEC)
// so CI can set low caps for deterministic 429 tests (the §5 OTP-cap learning).
//
// `checkReaction` is called by BOTH POST and DELETE reactions — the cap is "set or
// clear ≤ N/min" combined, not per-direction.
import { RateLimitedError } from "@twenty4/contracts";
import type { RedisClient } from "../redis.ts";

export interface SocialRateLimitConfig {
  commentCap: number;
  commentWindowSec: number;
  reactionCap: number;
  reactionWindowSec: number;
}

const COMMENT_PREFIX = "comment:rl:";
const REACTION_PREFIX = "reaction:rl:";

// All social rate-limit key globs, in ONE place — tests flush exactly these.
export const SOCIAL_REDIS_KEY_GLOBS = ["comment:*", "reaction:*"] as const;

export interface SocialRateLimiter {
  // Throttle comment-create per (author) user. Throws RateLimitedError (429).
  checkComment(userId: string): Promise<void>;
  // Throttle reaction set/clear per (caller) user (combined). Throws RateLimitedError (429).
  checkReaction(userId: string): Promise<void>;
}

// Increment a fixed-window counter; set the TTL on first hit. Returns the count.
async function bump(redis: RedisClient, key: string, windowSec: number): Promise<number> {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  return n;
}

export function createSocialRateLimiter(redis: RedisClient, cfg: SocialRateLimitConfig): SocialRateLimiter {
  return {
    async checkComment(userId) {
      const n = await bump(redis, `${COMMENT_PREFIX}${userId}`, cfg.commentWindowSec);
      if (n > cfg.commentCap) throw new RateLimitedError("Too many comments; slow down");
    },
    async checkReaction(userId) {
      const n = await bump(redis, `${REACTION_PREFIX}${userId}`, cfg.reactionWindowSec);
      if (n > cfg.reactionCap) throw new RateLimitedError("Too many reactions; slow down");
    },
  };
}
