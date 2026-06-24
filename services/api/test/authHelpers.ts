// Auth test helpers — build an app with the M2 auth subsystem wired, plus a
// Redis client and DB cleanup utilities. Low OTP caps are injectable per-test for
// deterministic throttle assertions.
import { buildApp } from "../src/app.ts";
import { createDb, type DbClient } from "../src/db.ts";
import { createRedis, type RedisClient } from "../src/redis.ts";
import { parseEnv, type Env } from "@twenty4/contracts";
import { loadEnvForTest } from "./env.ts";

export interface AuthTestEnvOverrides {
  OTP_MAX_PER_IP?: string;
  OTP_MAX_PER_IDENTIFIER?: string;
  OTP_VERIFY_MAX_ATTEMPTS?: string;
  OTP_WINDOW_SEC?: string;
  ADMIN_EMAILS?: string;
}

export function makeAuthEnv(overrides: AuthTestEnvOverrides = {}): Env {
  // Ensure root .env is loaded into process.env, then layer test overrides.
  loadEnvForTest();
  return parseEnv({
    ...process.env,
    NODE_ENV: "test",
    ADMIN_EMAILS: overrides.ADMIN_EMAILS ?? "admin@twenty4.app",
    // Default high caps so normal happy-path tests never trip; throttle test
    // passes low caps explicitly.
    OTP_MAX_PER_IP: overrides.OTP_MAX_PER_IP ?? "1000",
    OTP_MAX_PER_IDENTIFIER: overrides.OTP_MAX_PER_IDENTIFIER ?? "1000",
    OTP_VERIFY_MAX_ATTEMPTS: overrides.OTP_VERIFY_MAX_ATTEMPTS ?? "1000",
    OTP_WINDOW_SEC: overrides.OTP_WINDOW_SEC ?? "900",
  });
}

export function makeAuthDb(): DbClient {
  return createDb(process.env.DATABASE_URL!);
}

export function makeAuthRedis(): RedisClient {
  return createRedis(process.env.REDIS_URL!);
}

export async function buildAuthApp(args: { db: DbClient; redis: RedisClient; env: Env }) {
  const app = await buildApp({ db: args.db, redis: args.redis, env: args.env, nodeEnv: "test" });
  await app.ready();
  return app;
}

// Flush ONLY the OTP/rate-limit keys (otp:*) so reruns are deterministic without
// nuking unrelated Redis state.
export async function flushOtpKeys(redis: RedisClient): Promise<void> {
  const keys = await redis.keys("otp:*");
  if (keys.length > 0) await redis.del(...keys);
}

// Delete test users (by phone or email) + their sessions cascade via FK.
export async function cleanupUser(db: DbClient, opts: { phone?: string; email?: string }): Promise<void> {
  if (opts.phone) await db.sql`DELETE FROM "user" WHERE phone = ${opts.phone}`;
  if (opts.email) await db.sql`DELETE FROM "user" WHERE email = ${opts.email}`;
}

// Drive a phone OTP start→verify, returning the bearer token + userId.
export async function phoneLogin(
  app: Awaited<ReturnType<typeof buildAuthApp>>,
  identifier: string,
): Promise<{ token: string; userId: string }> {
  const start = await app.inject({
    method: "POST",
    url: "/auth/start",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ identifier, channel: "phone" }),
  });
  if (start.statusCode !== 202) throw new Error(`start failed: ${start.statusCode} ${start.body}`);
  const dev = await app.inject({ method: "GET", url: `/auth/dev/last-otp?identifier=${encodeURIComponent(identifier)}` });
  const code = dev.json().code as string;
  const verify = await app.inject({
    method: "POST",
    url: "/auth/verify",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ identifier, channel: "phone", code }),
  });
  if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.statusCode} ${verify.body}`);
  const body = verify.json();
  return { token: body.token, userId: body.userId };
}
