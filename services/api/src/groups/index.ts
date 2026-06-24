// Groups subsystem assembly (M3) — builds the requireSession guard + the invite
// rate limiter and registers the group/invite routes. Called by buildApp() after
// the auth subsystem exists (it reuses the same BA `auth` for requireSession).
import type { FastifyInstance } from "fastify";
import type { Env } from "@twenty4/contracts";
import { makeRequireSession } from "../auth/guards.ts";
import type { Auth } from "../auth/betterAuth.ts";
import { createInviteRateLimiter } from "./inviteRateLimit.ts";
import { registerGroupRoutes } from "./routes.ts";
import type { DbClient } from "../db.ts";
import type { RedisClient } from "../redis.ts";

export interface RegisterGroupsDeps {
  db: DbClient;
  redis: RedisClient;
  env: Env;
  auth: Auth;
}

export async function registerGroups(app: FastifyInstance, deps: RegisterGroupsDeps): Promise<void> {
  const { db, redis, env, auth } = deps;
  const requireSession = makeRequireSession({ auth, db });
  const inviteRateLimiter = createInviteRateLimiter(redis, {
    createCap: env.INVITE_CREATE_CAP,
    joinCap: env.INVITE_JOIN_CAP,
    windowSec: env.INVITE_WINDOW_SEC,
  });
  await registerGroupRoutes(app, { db, requireSession, inviteRateLimiter });
}
