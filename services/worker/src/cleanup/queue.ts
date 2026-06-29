// M9 cleanup — BullMQ wiring: one Worker per cleanup queue + the 4 repeatable
// reclaim sweep schedulers. Queue NAMES + jobId formatters are imported from
// @twenty4/contracts (the single cross-team source of truth the API enqueues to) —
// never re-derived here (a re-derived ':' jobId silently breaks delayed scheduling).
import {
  DAY_CLOSE_SWEEP_QUEUE,
  DELETE_MONTAGE_QUEUE,
  EXPIRE_MONTAGE_QUEUE,
  PURGE_ACCOUNT_QUEUE,
  RAW_PURGE_QUEUE,
  RAW_PURGE_SWEEP_QUEUE,
  SNAPSHOT_PURGE_SWEEP_QUEUE,
  SWEEP_EXPIRIES_QUEUE,
  type Env,
} from "@twenty4/contracts";
import { Queue, Worker } from "bullmq";
import { redisConnection } from "../queue.ts";
import type { WorkerDb } from "../db.ts";
import type { WorkerS3 } from "../s3.ts";
import type { CleanupDeps } from "./primitives.ts";
import {
  processDayCloseSweep,
  processDeleteMontage,
  processExpireMontage,
  processPurgeAccount,
  processRawPurge,
  processRawPurgeSweep,
  processSnapshotPurgeSweep,
  processSweepExpiries,
  type DeleteMontageJobData,
  type ExpireMontageJobData,
  type PurgeAccountJobData,
  type RawPurgeJobData,
} from "./processors.ts";

export interface StartCleanupDeps {
  env: Env;
  db: WorkerDb;
  s3: WorkerS3;
}

export interface CleanupRuntime {
  workers: Worker[];
  queues: Queue[];
  close: () => Promise<void>;
}

// Stable scheduler ids (never contain ':'). Idempotent upsert ⇒ a worker restart
// re-points the same scheduler instead of stacking duplicates.
const SWEEP_SCHEDULERS = {
  [SWEEP_EXPIRIES_QUEUE]: "sweep-expiries-scheduler",
  [RAW_PURGE_SWEEP_QUEUE]: "raw-purge-sweep-scheduler",
  [DAY_CLOSE_SWEEP_QUEUE]: "day-close-sweep-scheduler",
  [SNAPSHOT_PURGE_SWEEP_QUEUE]: "snapshot-purge-sweep-scheduler",
} as const;

/**
 * Register every cleanup worker (4 one-shot consumers + 4 sweep consumers) and
 * upsert the 4 repeatable sweep schedulers. concurrency 1 throughout (deletes are
 * cheap; serializing keeps the gate deterministic). Returns handles for shutdown.
 */
export function startCleanupWorkers(args: StartCleanupDeps): CleanupRuntime {
  const { env, db, s3 } = args;
  // Pin the snapshot bucket EXPLICITLY (was a silent `?? thumbnailsBucket` fallback in
  // the sweep). Defaults to the thumbnails bucket. M12 COUPLING TRAP: the report-WRITE
  // flow MUST store snapshots in THIS bucket or sweepSnapshotPurge won't reclaim them.
  const deps: CleanupDeps = { db, s3, env, snapshotBucket: env.SNAPSHOT_BUCKET ?? s3.thumbnailsBucket };
  const conn = () => redisConnection(env.REDIS_URL);
  const opts = { connection: conn(), concurrency: 1 } as const;

  const workers: Worker[] = [
    new Worker<ExpireMontageJobData>(
      EXPIRE_MONTAGE_QUEUE,
      async (job) => processExpireMontage(deps, job.data),
      opts,
    ),
    new Worker<RawPurgeJobData>(RAW_PURGE_QUEUE, async (job) => processRawPurge(deps, job.data), opts),
    new Worker<PurgeAccountJobData>(
      PURGE_ACCOUNT_QUEUE,
      async (job) => processPurgeAccount(deps, job.data),
      opts,
    ),
    new Worker<DeleteMontageJobData>(
      DELETE_MONTAGE_QUEUE,
      async (job) => processDeleteMontage(deps, job.data),
      opts,
    ),
    new Worker(SWEEP_EXPIRIES_QUEUE, async () => processSweepExpiries(deps), opts),
    new Worker(RAW_PURGE_SWEEP_QUEUE, async () => processRawPurgeSweep(deps), opts),
    new Worker(DAY_CLOSE_SWEEP_QUEUE, async () => processDayCloseSweep(deps), opts),
    new Worker(SNAPSHOT_PURGE_SWEEP_QUEUE, async () => processSnapshotPurgeSweep(deps), opts),
  ];
  for (const w of workers) {
    w.on("failed", (job, err) => console.error(`[cleanup] ${w.name} job ${job?.id} failed:`, err));
  }

  // ── repeatable sweep schedulers (idempotent upsert) ────────────────────────
  const intervals: Record<string, number> = {
    [SWEEP_EXPIRIES_QUEUE]: env.SWEEP_EXPIRIES_INTERVAL_SEC,
    [RAW_PURGE_SWEEP_QUEUE]: env.SWEEP_RAW_PURGE_INTERVAL_SEC,
    [DAY_CLOSE_SWEEP_QUEUE]: env.SWEEP_DAY_CLOSE_INTERVAL_SEC,
    [SNAPSHOT_PURGE_SWEEP_QUEUE]: env.SWEEP_SNAPSHOT_PURGE_INTERVAL_SEC,
  };
  const queues: Queue[] = [];
  for (const [queueName, schedulerId] of Object.entries(SWEEP_SCHEDULERS)) {
    const q = new Queue(queueName, { connection: conn() });
    void q.upsertJobScheduler(schedulerId, { every: intervals[queueName]! * 1000 }, { name: "sweep" });
    queues.push(q);
  }

  const close = async () => {
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(queues.map((q) => q.close()));
  };

  return { workers, queues, close };
}
