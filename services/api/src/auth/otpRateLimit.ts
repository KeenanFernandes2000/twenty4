// OTP rate limiting — per-IP and per-identifier fixed-window counters in Redis.
// Caps are env-configurable (OTP_MAX_PER_IP / OTP_MAX_PER_IDENTIFIER /
// OTP_WINDOW_SEC) so CI can set low caps for deterministic 429 tests.
// Also a per-identifier verify-attempt cap (OTP_VERIFY_MAX_ATTEMPTS).
import { RateLimitedError } from "@twenty4/contracts";
import type { RedisClient } from "../redis.ts";

export interface OtpRateLimitConfig {
  maxPerIp: number;
  maxPerIdentifier: number;
  windowSec: number;
  verifyMaxAttempts: number;
}

// Redis key prefixes (flushed by test globalSetup for rerun determinism).
const IP_PREFIX = "otp:rl:ip:";
const ID_PREFIX = "otp:rl:id:";
const VERIFY_PREFIX = "otp:rl:verify:";

// All OTP rate-limit / dev-store key globs, in ONE place — the test globalSetup
// flushes exactly these (and nothing else) between runs.
export const OTP_REDIS_KEY_GLOBS = ["otp:*"] as const;

export interface OtpRateLimiter {
  // Throttle an OTP-start. Throws RateLimitedError (429) when a cap is exceeded.
  checkStart(args: { ip: string; identifier: string }): Promise<void>;
  // Throttle verify attempts per identifier. Throws on too many.
  checkVerify(identifier: string): Promise<void>;
}

// Increment a fixed-window counter; set the TTL on first hit. Returns the count.
async function bump(redis: RedisClient, key: string, windowSec: number): Promise<number> {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  return n;
}

export function createOtpRateLimiter(redis: RedisClient, cfg: OtpRateLimitConfig): OtpRateLimiter {
  return {
    async checkStart({ ip, identifier }) {
      const ipCount = await bump(redis, `${IP_PREFIX}${ip}`, cfg.windowSec);
      if (ipCount > cfg.maxPerIp) {
        throw new RateLimitedError("Too many OTP requests from this IP");
      }
      const idCount = await bump(redis, `${ID_PREFIX}${identifier}`, cfg.windowSec);
      if (idCount > cfg.maxPerIdentifier) {
        throw new RateLimitedError("Too many OTP requests for this identifier");
      }
    },

    async checkVerify(identifier) {
      const count = await bump(redis, `${VERIFY_PREFIX}${identifier}`, cfg.windowSec);
      if (count > cfg.verifyMaxAttempts) {
        throw new RateLimitedError("Too many verification attempts");
      }
    },
  };
}
