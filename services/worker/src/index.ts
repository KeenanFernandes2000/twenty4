// @twenty4/worker — BullMQ job runner.
//
// M4 stands up the `validate-media` job (concurrency 1 — deterministic tests, low
// volume; raise once the M7 render worker settles queue behaviour). The processor
// (validateMedia.ts) is exported so tests can run a job synchronously against the
// live stack; here we wire it to a real BullMQ Worker for the standalone process.
import { parseEnv, type Env } from "@twenty4/contracts";
import { createWorkerDb, type WorkerDb } from "./db.ts";
import { createWorkerS3, type WorkerS3 } from "./s3.ts";
import { processValidateMedia, type ValidateMediaJobData } from "./validateMedia.ts";
import { redisConnection, VALIDATE_MEDIA_QUEUE, Worker } from "./queue.ts";

export { processValidateMedia } from "./validateMedia.ts";
export { createWorkerDb } from "./db.ts";
export { createWorkerS3 } from "./s3.ts";
export { VALIDATE_MEDIA_QUEUE, validateMediaJobId, createValidateMediaQueue } from "./queue.ts";

export interface StartWorkerDeps {
  env: Env;
  db: WorkerDb;
  s3: WorkerS3;
}

// Start the validate-media BullMQ worker (concurrency 1). Returns the Worker so a
// caller can close it on shutdown.
export function startValidateMediaWorker(deps: StartWorkerDeps): Worker<ValidateMediaJobData> {
  const { env, db, s3 } = deps;
  const worker = new Worker<ValidateMediaJobData>(
    VALIDATE_MEDIA_QUEUE,
    async (job) => processValidateMedia({ db, s3 }, job.data),
    { connection: redisConnection(env.REDIS_URL), concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[validate-media] job ${job?.id} failed:`, err);
  });
  return worker;
}

export function startWorker(): void {
  const env = parseEnv(process.env);
  const db = createWorkerDb(env.DATABASE_URL);
  const s3 = createWorkerS3(env);
  const worker = startValidateMediaWorker({ env, db, s3 });
  console.log(`[worker] validate-media worker started (concurrency 1) on ${VALIDATE_MEDIA_QUEUE}`);

  const shutdown = async () => {
    await worker.close();
    await db.sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  startWorker();
}
