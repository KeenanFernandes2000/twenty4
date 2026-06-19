/**
 * @twenty4/worker entry.
 *
 * SLICE 1 (this agent) authored the RENDER half only — the `Renderer` interface,
 * `RemotionRenderer`, the factory, and media helpers. The BullMQ Workers and the
 * intelligence layer (beat analysis → scoring → EDL build) are authored by a
 * SEPARATE agent in the next slice; this entry deliberately wires nothing yet.
 *
 * What the intelligence agent must produce and hand to the renderer:
 *   - a valid `Edl` (`@twenty4/contracts/edl`) — see `infra/remotion` sampleEdl
 *     `buildBeatAlignedEdl` for the exact shape and a working reference builder.
 *   - a `srcMap` (mediaRef → file:// path) after downloading S3 media to a temp
 *     dir; pass it as `RenderOptions.srcMap`.
 * Then: `getRenderer().render(edl, { srcMap, outDir })` → upload videoPath/thumb.
 */
import { Worker, Queue, type Job } from 'bullmq';
import {
  MEDIA_QUEUE,
  VALIDATE_MEDIA_JOB,
  MONTAGE_QUEUE,
  RENDER_MONTAGE_JOB,
  EXPIRE_MONTAGE_JOB,
  CLEANUP_RAW_JOB,
  SUPERSEDE_CLEANUP_JOB,
  SWEEP_EXPIRIES_JOB,
  DAY_CLOSE_SWEEP_JOB,
  ACCOUNT_QUEUE,
  PURGE_ACCOUNT_JOB,
  type ValidateMediaJob,
  type RenderMontageJob,
  type ExpireMontageJob,
  type CleanupRawJob,
  type SupersedeCleanupJob,
  type PurgeAccountJob,
} from './queue.js';
import { validateMedia } from './jobs/validateMedia.js';
import { renderMontage } from './jobs/renderMontage.js';
import { expireMontage } from './jobs/expireMontage.js';
import { cleanupRaw } from './jobs/cleanupRaw.js';
import { supersedeCleanup } from './jobs/supersedeCleanup.js';
import { sweepExpiries } from './jobs/sweepExpiries.js';
import { dayCloseSweep } from './jobs/dayCloseSweep.js';
import { purgeAccount } from './jobs/purgeAccount.js';
import { closeDb } from './db.js';
import { closeStorage } from './storage.js';

export { getRenderer, RemotionRenderer } from './render/index.js';
export type {
  Renderer,
  RenderOptions,
  RenderResult,
  RenderStatus,
  SrcMap,
} from './render/index.js';
export * as media from './media/index.js';
export { validateMedia } from './jobs/validateMedia.js';
export type { ValidateMediaResult } from './jobs/validateMedia.js';
export { renderMontage } from './jobs/renderMontage.js';
export type { RenderMontageResult } from './jobs/renderMontage.js';

/* --------------------- Slice 7: deletion-lifecycle jobs -------------------- */
// Re-export the deletion jobs so the API deletion suite can invoke the EXACT same
// functions the BullMQ workers run (deterministic tests; the wiring is typechecked).
export { expireMontage } from './jobs/expireMontage.js';
export type { ExpireMontageResult } from './jobs/expireMontage.js';
export { sweepExpiries } from './jobs/sweepExpiries.js';
export type { SweepExpiriesResult } from './jobs/sweepExpiries.js';
export { cleanupRaw } from './jobs/cleanupRaw.js';
export type { CleanupRawResult } from './jobs/cleanupRaw.js';
export { supersedeCleanup } from './jobs/supersedeCleanup.js';
export type { SupersedeCleanupResult } from './jobs/supersedeCleanup.js';
export { dayCloseSweep } from './jobs/dayCloseSweep.js';
export type { DayCloseSweepResult } from './jobs/dayCloseSweep.js';
export { purgeAccount } from './jobs/purgeAccount.js';
export type { PurgeAccountResult } from './jobs/purgeAccount.js';
export {
  deleteMontageContent,
  type DeleteMontageResult,
  type MontageDeleteReason,
} from './jobs/deleteMontageContent.js';
export { purgeRawForDay, type PurgeRawResult } from './jobs/purgeRawForDay.js';
export { drainAnalytics, emitAnalytics } from './lib/analytics.js';
export { writeAuditTombstone, sanitizeMetadata } from './lib/audit.js';

/* ----------------------------- BullMQ workers ------------------------------ */

import { env } from './env.js';

/** Parse REDIS_URL into BullMQ connection options (maxRetriesPerRequest:null). */
function redisConnection(): { host: string; port: number; maxRetriesPerRequest: null } {
  const u = new URL(env.REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    maxRetriesPerRequest: null,
  };
}

/**
 * Start the media-validation Worker (§6). Consumes `validate-media` and runs the
 * hierarchy. A job NEVER crashes the worker: `validateMedia` swallows item errors
 * and marks the row invalid/failed; the BullMQ handler only rethrows for true
 * infra faults (so BullMQ's retry/backoff applies), but the row is still updated.
 */
export function startMediaWorker(): Worker<ValidateMediaJob> {
  const worker = new Worker<ValidateMediaJob>(
    MEDIA_QUEUE,
    async (job: Job<ValidateMediaJob>) => {
      if (job.name !== VALIDATE_MEDIA_JOB) return;
      const serverReceiveTime = job.data.serverReceiveTime
        ? new Date(job.data.serverReceiveTime)
        : new Date();
      return validateMedia(job.data.mediaId, serverReceiveTime);
    },
    { connection: redisConnection(), concurrency: 4 },
  );
  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] validate-media job ${job?.id} failed:`, err.message);
  });
  return worker;
}

/**
 * Start the montage-render Worker (§7.3). Consumes `render-montage` at concurrency
 * 1 (one self-hosted renderer; the EDL build + headless Chrome already saturate the
 * box). §7.4: a job throws on a render fault so BullMQ retries (attempts:2 = one
 * retry); on the FINAL attempt `renderMontage` marks the row `failed` + cleans up
 * partial S3 BEFORE rethrowing, so the row never sticks in `generating` and no
 * orphaned objects are left. The worker process itself never crashes on a bad job.
 */
export function startRenderWorker(): Worker {
  const worker = new Worker(
    MONTAGE_QUEUE,
    async (job: Job) => {
      // The montage queue carries the render job AND the §6 deletion-lifecycle jobs
      // (expire-montage delayed +24h, cleanup-raw delayed +60min, and the repeatable
      // sweep-expiries / day-close-sweep). Dispatch by job name. Every deletion job
      // is IDEMPOTENT, so a retry/redelivery is always safe.
      switch (job.name) {
        case RENDER_MONTAGE_JOB: {
          const d = job.data as RenderMontageJob;
          const maxAttempts = job.opts.attempts ?? 1;
          const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
          return renderMontage(d.montageId, isFinalAttempt);
        }
        case EXPIRE_MONTAGE_JOB: {
          const d = job.data as ExpireMontageJob;
          return expireMontage(d.montageId);
        }
        case CLEANUP_RAW_JOB: {
          const d = job.data as CleanupRawJob;
          return cleanupRaw(d.userId, d.dayBucket, d.montageId);
        }
        case SUPERSEDE_CLEANUP_JOB: {
          const d = job.data as SupersedeCleanupJob;
          return supersedeCleanup(d.priorMontageId);
        }
        case SWEEP_EXPIRIES_JOB:
          return sweepExpiries();
        case DAY_CLOSE_SWEEP_JOB:
          return dayCloseSweep();
        default:
          return; // unknown job — ignore
      }
    },
    // concurrency 1: the render job saturates the box; the lightweight deletion jobs
    // share the lane but are fast. (A separate queue/worker could split them later.)
    { connection: redisConnection(), concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] montage queue job ${job?.name} ${job?.id} failed:`, err.message);
  });
  return worker;
}

/**
 * Start the account-purge Worker (§5/§11). Consumes `purge-account` (enqueued by
 * DELETE /users/me) and hard-deletes EVERYTHING the user owns + the row, with an
 * audit tombstone. Idempotent — a redelivery after the row is gone no-ops.
 */
export function startAccountWorker(): Worker<PurgeAccountJob> {
  const worker = new Worker<PurgeAccountJob>(
    ACCOUNT_QUEUE,
    async (job: Job<PurgeAccountJob>) => {
      if (job.name !== PURGE_ACCOUNT_JOB) return;
      return purgeAccount(job.data.userId, job.data.requestedAt);
    },
    { connection: redisConnection(), concurrency: 2 },
  );
  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] purge-account job ${job?.id} failed:`, err.message);
  });
  return worker;
}

/**
 * Register the REPEATABLE §6 sweeps on the montage queue (belt-and-suspenders):
 *   - sweep-expiries   every 3 min  → deletes published montages past expiry_at
 *                      (covers a lost/failed delayed expire-montage job).
 *   - day-close-sweep  every 30 min → purges CLOSED unpublished days' raw + drafts
 *                      (covers media added but never published before the 4am roll).
 * Repeatable jobs are deduped by BullMQ on their repeat key, so calling this on
 * every boot is idempotent (it won't stack duplicate schedules).
 */
export async function registerSweeps(): Promise<Queue> {
  const queue = new Queue(MONTAGE_QUEUE, { connection: redisConnection() });
  await queue.add(
    SWEEP_EXPIRIES_JOB,
    {},
    { repeat: { every: 3 * 60 * 1000 }, removeOnComplete: true, removeOnFail: 50 },
  );
  await queue.add(
    DAY_CLOSE_SWEEP_JOB,
    {},
    { repeat: { every: 30 * 60 * 1000 }, removeOnComplete: true, removeOnFail: 50 },
  );
  return queue;
}

// Running this file directly boots the worker process (queue consumers).
if (import.meta.url === `file://${process.argv[1]}`) {
  const mediaWorker = startMediaWorker();
  const renderWorker = startRenderWorker(); // render + expire + cleanup + sweeps
  const accountWorker = startAccountWorker();
  // Register the repeatable §6 sweeps (idempotent on the repeat key).
  const sweepQueuePromise = registerSweeps().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[worker] failed to register repeatable sweeps:', err);
    return undefined;
  });
  // eslint-disable-next-line no-console
  console.log(
    '@twenty4/worker: media + montage(render/expire/cleanup/sweeps) + account-purge workers running.',
  );

  const shutdown = async (): Promise<void> => {
    await mediaWorker.close();
    await renderWorker.close();
    await accountWorker.close();
    const sweepQueue = await sweepQueuePromise;
    if (sweepQueue) await sweepQueue.close().catch(() => undefined);
    // Tear down the shared headless browser cleanly (the renderer caches one).
    try {
      const { getRenderer } = await import('./render/index.js');
      await getRenderer().close?.();
    } catch {
      /* nothing to close */
    }
    await closeDb();
    closeStorage();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
