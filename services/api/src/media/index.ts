// Media subsystem assembly (M4) — builds the requireSession guard, the S3 clients
// (signer=public endpoint, internal=localhost), the validate-media queue, and
// registers the media routes. Called by buildApp() alongside auth/groups.
import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { Env } from "@twenty4/contracts";
import { makeRequireSession } from "../auth/guards.ts";
import type { Auth } from "../auth/betterAuth.ts";
import { createS3 } from "./s3.ts";
import { createValidateMediaQueue, type ValidateMediaJobData } from "./queue.ts";
import { registerMediaRoutes } from "./routes.ts";
import type { DbClient } from "../db.ts";

export interface RegisterMediaDeps {
  db: DbClient;
  env: Env;
  auth: Auth;
  // Optional injected queue (tests pass one so they can share/inspect it). When
  // omitted, a queue is created from REDIS_URL.
  queue?: Queue<ValidateMediaJobData>;
}

export async function registerMedia(app: FastifyInstance, deps: RegisterMediaDeps): Promise<void> {
  const { db, env, auth } = deps;
  const requireSession = makeRequireSession({ auth, db });
  const s3 = createS3(env);
  const queue = deps.queue ?? createValidateMediaQueue(env.REDIS_URL);
  await registerMediaRoutes(app, {
    db,
    requireSession,
    s3,
    queue,
    rawTtlHours: env.MEDIA_RAW_TTL_HOURS,
    maxBytes: env.MEDIA_MAX_BYTES,
    maxItemsPerDay: env.MEDIA_MAX_ITEMS_PER_DAY,
  });
}
