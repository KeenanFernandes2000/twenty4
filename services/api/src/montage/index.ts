// Montage subsystem assembly (M7) — builds the requireSession guard, reuses the
// shared S3 clients (montages-bucket preview presign), creates the render-montage
// queue, and registers the montage routes. Called by buildApp() alongside
// auth/groups/media.
import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { Env } from "@twenty4/contracts";
import { makeRequireSession } from "../auth/guards.ts";
import type { Auth } from "../auth/betterAuth.ts";
import { createS3 } from "../media/s3.ts";
import { createRenderMontageQueue, type RenderMontageJobData } from "./queue.ts";
import { registerMontageRoutes } from "./routes.ts";
import type { CleanupQueues } from "../cleanup/queue.ts";
import type { DbClient } from "../db.ts";

export interface RegisterMontageDeps {
  db: DbClient;
  env: Env;
  auth: Auth;
  // Optional injected queue (tests pass one so they can share/inspect it). When
  // omitted, a queue is created from REDIS_URL.
  queue?: Queue<RenderMontageJobData>;
  // M9 cleanup queues — passed down from buildApp (shared with auth + admin) so
  // publish/replace/delete enqueue the expire/raw-purge/delete jobs.
  cleanupQueues?: CleanupQueues;
}

export async function registerMontage(app: FastifyInstance, deps: RegisterMontageDeps): Promise<void> {
  const { db, env, auth } = deps;
  const requireSession = makeRequireSession({ auth, db });
  const s3 = createS3(env);
  const queue = deps.queue ?? createRenderMontageQueue(env.REDIS_URL);
  await registerMontageRoutes(app, {
    db,
    requireSession,
    s3,
    queue,
    cleanupQueues: deps.cleanupQueues,
    minMedia: env.MONTAGE_MIN_MEDIA,
    expiryHours: env.MONTAGE_EXPIRY_HOURS,
    expirySec: env.MONTAGE_EXPIRY_SEC,
    rawPurgeGraceMin: env.RAW_PURGE_GRACE_MIN,
    remotionDir: env.INFRA_REMOTION_DIR,
  });
}
