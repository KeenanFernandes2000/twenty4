/**
 * Pluggable OTP transport.
 *
 * DEV (NODE_ENV !== 'production'):
 *   - logs the code, AND
 *   - stores the latest code in Redis at `otp:<identifier>` (TTL 10 min) so an
 *     automated test (or the dev-only GET /auth/dev/last-otp route) can retrieve
 *     it and complete a REAL sign-up against the live stack.
 *
 * PROD: a real email/SMS sender — left as a clearly-marked TODO stub that throws
 * so production can't silently swallow OTPs.
 */
import { redis } from '../redis/index.js';
import { env } from '../env.js';

/** Channel the OTP is delivered over. */
export type OtpChannel = 'email' | 'phone';

const OTP_TTL_SECONDS = 600; // 10 minutes; mirrors the verification expiry.

/** Redis key holding the latest OTP for an identifier (dev retrieval). */
export const otpRedisKey = (identifier: string): string => `otp:${identifier}`;

/**
 * Deliver an OTP. Returns nothing; throws only if delivery genuinely fails (prod).
 */
export async function sendOtp(args: {
  channel: OtpChannel;
  identifier: string;
  code: string;
  /** Better Auth OTP "type": sign-in / email-verification / forget-password. */
  type?: string;
}): Promise<void> {
  const { channel, identifier, code, type } = args;

  if (env.NODE_ENV !== 'production') {
    // 1) Log it (visible in dev server output).
    console.info(
      `[otp:dev] ${channel} OTP for "${identifier}" (${type ?? 'sign-in'}): ${code}`,
    );
    // 2) Store retrievably so tests/dev-route can fetch the latest code.
    try {
      await ensureRedis();
      await redis.set(otpRedisKey(identifier), code, 'EX', OTP_TTL_SECONDS);
    } catch (err) {
      // Non-fatal in dev — the log line above is still the source of truth.
      console.warn('[otp:dev] failed to cache OTP in redis', err);
    }
    return;
  }

  // PROD transport.
  // TODO(prod): integrate a real email provider (SES/Resend) for `email` and an
  // SMS provider (Twilio/SNS) for `phone`. Until then, refuse to pretend we sent.
  throw new Error(
    `OTP transport not configured for production (channel=${channel}). ` +
      `Wire an email/SMS provider before enabling prod auth.`,
  );
}

/** Read back the latest dev OTP for an identifier (dev-only route + tests). */
export async function readDevOtp(identifier: string): Promise<string | null> {
  if (env.NODE_ENV === 'production') return null;
  try {
    await ensureRedis();
    return await redis.get(otpRedisKey(identifier));
  } catch {
    return null;
  }
}

/** Lazily connect the shared ioredis client (it uses lazyConnect). */
async function ensureRedis(): Promise<void> {
  if (
    redis.status === 'wait' ||
    redis.status === 'close' ||
    redis.status === 'end'
  ) {
    await redis.connect();
  }
}
