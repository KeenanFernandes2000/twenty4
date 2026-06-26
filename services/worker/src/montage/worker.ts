// render-montage BullMQ worker (M7 §3). A SECOND Worker alongside validate-media,
// concurrency 1 (a single Remotion render at a time — §10 throttle). The processor
// (renderMontage.ts) is exported so tests run it synchronously; here we wire it to a
// real Worker for the standalone process.
import type { Env } from "@twenty4/contracts";
import { Worker } from "bullmq";
import type { WorkerDb } from "../db.ts";
import type { WorkerS3 } from "../s3.ts";
import { redisConnection } from "../queue.ts";
import { processRenderMontage, type RenderMontageDeps } from "./renderMontage.ts";
import { RENDER_MONTAGE_QUEUE, type RenderMontageJobData } from "./queue.ts";

export interface StartRenderMontageDeps {
  env: Env;
  db: WorkerDb;
  s3: WorkerS3;
}

export function startRenderMontageWorker(
  deps: StartRenderMontageDeps,
): Worker<RenderMontageJobData> {
  const { env, db, s3 } = deps;
  const jobDeps: RenderMontageDeps = { db, s3, env };
  const worker = new Worker<RenderMontageJobData>(
    RENDER_MONTAGE_QUEUE,
    async (job) => processRenderMontage(jobDeps, job.data, job),
    { connection: redisConnection(env.REDIS_URL), concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[render-montage] job ${job?.id} failed:`, err);
  });
  return worker;
}
