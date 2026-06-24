// M3 group test helpers — build the full app (auth + groups wired), seed N
// distinct authenticated users via the dev OTP flow, and flush invite/otp keys.
import { buildApp } from "../src/app.ts";
import { createDb, type DbClient } from "../src/db.ts";
import { createRedis, type RedisClient } from "../src/redis.ts";
import { parseEnv, type Env } from "@twenty4/contracts";
import { loadEnvForTest } from "./env.ts";
import { phoneLogin } from "./authHelpers.ts";

export interface GroupTestEnvOverrides {
  INVITE_CREATE_CAP?: string;
  INVITE_JOIN_CAP?: string;
  INVITE_WINDOW_SEC?: string;
}

export function makeGroupEnv(overrides: GroupTestEnvOverrides = {}): Env {
  loadEnvForTest();
  return parseEnv({
    ...process.env,
    NODE_ENV: "test",
    // High OTP caps so seeding many users never trips the OTP throttle.
    OTP_MAX_PER_IP: "100000",
    OTP_MAX_PER_IDENTIFIER: "100000",
    OTP_VERIFY_MAX_ATTEMPTS: "100000",
    OTP_WINDOW_SEC: "900",
    // High invite caps by default; the rate-limit test overrides with low caps.
    INVITE_CREATE_CAP: overrides.INVITE_CREATE_CAP ?? "100000",
    INVITE_JOIN_CAP: overrides.INVITE_JOIN_CAP ?? "100000",
    INVITE_WINDOW_SEC: overrides.INVITE_WINDOW_SEC ?? "900",
  });
}

export function makeGroupDb(): DbClient {
  return createDb(process.env.DATABASE_URL!);
}

export function makeGroupRedis(): RedisClient {
  return createRedis(process.env.REDIS_URL!);
}

export async function buildGroupApp(args: { db: DbClient; redis: RedisClient; env: Env }) {
  const app = await buildApp({ db: args.db, redis: args.redis, env: args.env, nodeEnv: "test" });
  await app.ready();
  return app;
}

export async function flushInviteKeys(redis: RedisClient): Promise<void> {
  for (const glob of ["invite:*", "otp:*"]) {
    const keys = await redis.keys(glob);
    if (keys.length > 0) await redis.del(...keys);
  }
}

// Seed `count` distinct phone-verified users; returns their bearer + userId.
export async function seedUsers(
  app: Awaited<ReturnType<typeof buildGroupApp>>,
  phones: string[],
): Promise<{ token: string; userId: string; phone: string }[]> {
  const out: { token: string; userId: string; phone: string }[] = [];
  for (const phone of phones) {
    const { token, userId } = await phoneLogin(app, phone);
    out.push({ token, userId, phone });
  }
  return out;
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export async function cleanupGroupsByPhones(db: DbClient, phones: string[]): Promise<void> {
  // group/group_member/group_invite all cascade from user.id; deleting the users
  // removes their owned groups + memberships. Delete owned groups first defensively.
  for (const phone of phones) {
    await db.sql`DELETE FROM "group" WHERE owner_id IN (SELECT id FROM "user" WHERE phone = ${phone})`;
    await db.sql`DELETE FROM "user" WHERE phone = ${phone}`;
  }
}
