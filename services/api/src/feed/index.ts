// Feed + social subsystem assembly (M8) — builds the requireSession guard, reuses
// the shared S3 clients (signed playback/thumbnail presign), builds the social rate
// limiter (per-user comment/reaction fixed-window caps), and registers the feed +
// reaction + comment routes. Called by buildApp() alongside auth/groups/media/montage.
import type { FastifyInstance } from "fastify";
import type { Env } from "@twenty4/contracts";
import { makeRequireSession } from "../auth/guards.ts";
import type { Auth } from "../auth/betterAuth.ts";
import { createS3 } from "../media/s3.ts";
import { createSocialRateLimiter } from "./socialRateLimit.ts";
import { registerFeedRoutes } from "./routes.ts";
import type { DbClient } from "../db.ts";
import type { RedisClient } from "../redis.ts";

export interface RegisterFeedDeps {
  db: DbClient;
  env: Env;
  auth: Auth;
  redis: RedisClient;
}

export async function registerFeed(app: FastifyInstance, deps: RegisterFeedDeps): Promise<void> {
  const { db, env, auth, redis } = deps;
  const requireSession = makeRequireSession({ auth, db });
  const s3 = createS3(env);
  const rateLimiter = createSocialRateLimiter(redis, {
    commentCap: env.COMMENT_CREATE_CAP,
    commentWindowSec: env.COMMENT_WINDOW_SEC,
    reactionCap: env.REACTION_SET_CAP,
    reactionWindowSec: env.REACTION_WINDOW_SEC,
  });
  await registerFeedRoutes(app, {
    db,
    requireSession,
    s3,
    rateLimiter,
    commentMaxLength: env.COMMENT_MAX_LENGTH,
  });
}
