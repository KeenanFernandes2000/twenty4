/**
 * Reusable Redis-backed rate limiting for the auth surface (§8 security-hardening).
 *
 * Two distinct mechanisms live here:
 *
 *  1. `consumeFixedWindow` — a generic fixed-window counter in Redis. INCR on a
 *     namespaced key with an EX on first hit; over the cap → over-limit. Used to
 *     cap OTP SENDS (per-identifier + per-IP) and VERIFY ATTEMPTS (per-identifier).
 *
 *  2. The verify-attempt budget is deliberately keyed on the IDENTIFIER (not the
 *     challenge/code), so re-calling POST /auth/start (which re-issues a fresh
 *     OTP) does NOT reset the failure budget — closing the "brute-force reset via
 *     re-issue" hole. The counter only resets when the window elapses OR a verify
 *     genuinely succeeds (caller clears it).
 *
 * The shared ioredis client (lazyConnect) is used. If Redis is unreachable we
 * FAIL CLOSED for security-relevant counters (treat as over-limit) rather than
 * silently allowing unbounded attempts — callers pass `failClosed`.
 */
import { errors } from '@twenty4/contracts/errors';
import { redis } from '../redis/index.js';

/** Connect the shared lazy client if it isn't already up. */
async function ensureRedis(): Promise<void> {
  if (
    redis.status === 'wait' ||
    redis.status === 'close' ||
    redis.status === 'end'
  ) {
    await redis.connect();
  }
}

/** Normalize an identifier for keying (lowercase, trim) so EMAIL == email. */
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

export interface FixedWindowOptions {
  /** Logical bucket name, e.g. 'otp:send:id' — namespaced into the Redis key. */
  bucket: string;
  /** The per-subject key suffix (identifier or IP). */
  subject: string;
  /** Max permitted hits within the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * When Redis is unreachable: if true, treat as over-limit (fail closed). For
   * security counters (OTP send / verify attempts) we fail closed.
   */
  failClosed?: boolean;
}

export interface FixedWindowResult {
  /** True when this hit is WITHIN the cap (allowed). */
  allowed: boolean;
  /** Current count after this hit (0 if it could not be recorded). */
  count: number;
  /** Seconds until the window resets (best-effort; 0 if unknown). */
  retryAfter: number;
}

/** Build the namespaced Redis key for a fixed-window bucket. */
function windowKey(bucket: string, subject: string): string {
  return `rl:${bucket}:${subject}`;
}

/**
 * Record one hit against a fixed-window counter and report whether it is allowed.
 * INCR is atomic; we set the TTL only on the first hit so the window is anchored
 * to the FIRST request in the window (a true fixed window).
 */
export async function consumeFixedWindow(
  opts: FixedWindowOptions,
): Promise<FixedWindowResult> {
  const key = windowKey(opts.bucket, opts.subject);
  try {
    await ensureRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, opts.windowSeconds);
    }
    let ttl = await redis.ttl(key);
    // ttl can be -1 (no expire) or -2 (no key) on races; re-arm defensively.
    if (ttl < 0) {
      await redis.expire(key, opts.windowSeconds);
      ttl = opts.windowSeconds;
    }
    return {
      allowed: count <= opts.max,
      count,
      retryAfter: ttl > 0 ? ttl : opts.windowSeconds,
    };
  } catch {
    // Redis down: fail closed for security counters, open otherwise.
    if (opts.failClosed) {
      return { allowed: false, count: opts.max + 1, retryAfter: opts.windowSeconds };
    }
    return { allowed: true, count: 0, retryAfter: 0 };
  }
}

/**
 * Read the current count WITHOUT incrementing (used to enforce the verify-attempt
 * budget BEFORE attempting a verify, so a re-issued OTP can't grant fresh tries).
 */
export async function peekFixedWindow(
  bucket: string,
  subject: string,
  failClosed = false,
): Promise<number> {
  try {
    await ensureRedis();
    const raw = await redis.get(windowKey(bucket, subject));
    return raw ? Number(raw) : 0;
  } catch {
    // Fail closed → report a high count so the caller blocks.
    return failClosed ? Number.MAX_SAFE_INTEGER : 0;
  }
}

/** Clear a counter (e.g. after a SUCCESSFUL verify resets the attempt budget). */
export async function clearFixedWindow(
  bucket: string,
  subject: string,
): Promise<void> {
  try {
    await ensureRedis();
    await redis.del(windowKey(bucket, subject));
  } catch {
    /* best-effort */
  }
}

/* --------------------------- auth-specific limits -------------------------- */

/** OTP send caps: ≤5 per identifier AND ≤5 per IP per 10 minutes. */
export const OTP_SEND_BUCKET_ID = 'otp:send:id';
export const OTP_SEND_BUCKET_IP = 'otp:send:ip';
export const OTP_SEND_MAX = 5;
export const OTP_SEND_WINDOW = 600;

/** Verify attempt cap: ≤5 per identifier per 10 minutes (survives re-issue). */
export const VERIFY_ATTEMPT_BUCKET = 'otp:verify:id';
export const VERIFY_ATTEMPT_MAX = 5;
export const VERIFY_ATTEMPT_WINDOW = 600;

/**
 * Throttle an OTP SEND. Caps per-identifier and per-IP independently; exceeding
 * EITHER → throws 429 rate_limited. Fails closed if Redis is down.
 */
export async function throttleOtpSend(args: {
  identifier: string;
  ip: string;
}): Promise<void> {
  const id = normalizeIdentifier(args.identifier);
  const byId = await consumeFixedWindow({
    bucket: OTP_SEND_BUCKET_ID,
    subject: id,
    max: OTP_SEND_MAX,
    windowSeconds: OTP_SEND_WINDOW,
    failClosed: true,
  });
  const byIp = await consumeFixedWindow({
    bucket: OTP_SEND_BUCKET_IP,
    subject: args.ip,
    max: OTP_SEND_MAX,
    windowSeconds: OTP_SEND_WINDOW,
    failClosed: true,
  });
  if (!byId.allowed || !byIp.allowed) {
    const retryAfter = Math.max(byId.retryAfter, byIp.retryAfter);
    throw errors.rateLimited('too many OTP requests; try again later', {
      retryAfter,
    });
  }
}

/**
 * Enforce + record a VERIFY attempt budget keyed on the identifier. Call this
 * BEFORE attempting the verify. Crucially the counter is keyed on the identifier
 * and is NOT cleared by /auth/start re-issuing an OTP, so re-issue cannot reset
 * the budget. On a successful verify the caller MUST call `clearVerifyBudget`.
 *
 * Returns the normalized identifier (for the caller to clear on success).
 */
export async function consumeVerifyBudget(identifier: string): Promise<string> {
  const id = normalizeIdentifier(identifier);
  // Block on the EXISTING count first (so a re-issue can't grant a fresh try
  // beyond the cap), then record this attempt.
  const existing = await peekFixedWindow(VERIFY_ATTEMPT_BUCKET, id, true);
  if (existing >= VERIFY_ATTEMPT_MAX) {
    const retryAfter = await ttlOf(VERIFY_ATTEMPT_BUCKET, id);
    throw errors.rateLimited('too many verification attempts; try again later', {
      retryAfter,
    });
  }
  const res = await consumeFixedWindow({
    bucket: VERIFY_ATTEMPT_BUCKET,
    subject: id,
    max: VERIFY_ATTEMPT_MAX,
    windowSeconds: VERIFY_ATTEMPT_WINDOW,
    failClosed: true,
  });
  if (!res.allowed) {
    throw errors.rateLimited('too many verification attempts; try again later', {
      retryAfter: res.retryAfter,
    });
  }
  return id;
}

/** Reset the verify-attempt budget for an identifier (after a real success). */
export async function clearVerifyBudget(identifier: string): Promise<void> {
  await clearFixedWindow(VERIFY_ATTEMPT_BUCKET, normalizeIdentifier(identifier));
}

/** Best-effort TTL lookup for a bucket key (for retryAfter hints). */
async function ttlOf(bucket: string, subject: string): Promise<number> {
  try {
    await ensureRedis();
    const ttl = await redis.ttl(windowKey(bucket, subject));
    return ttl > 0 ? ttl : VERIFY_ATTEMPT_WINDOW;
  } catch {
    return VERIFY_ATTEMPT_WINDOW;
  }
}
