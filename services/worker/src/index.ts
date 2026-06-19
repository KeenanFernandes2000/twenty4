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
import { Worker, type Job } from 'bullmq';
import {
  MEDIA_QUEUE,
  VALIDATE_MEDIA_JOB,
  MONTAGE_QUEUE,
  RENDER_MONTAGE_JOB,
  type ValidateMediaJob,
  type RenderMontageJob,
} from './queue.js';
import { validateMedia } from './jobs/validateMedia.js';
import { renderMontage } from './jobs/renderMontage.js';
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
export function startRenderWorker(): Worker<RenderMontageJob> {
  const worker = new Worker<RenderMontageJob>(
    MONTAGE_QUEUE,
    async (job: Job<RenderMontageJob>) => {
      if (job.name !== RENDER_MONTAGE_JOB) return; // ignore expire/cleanup (Slice 7)
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
      return renderMontage(job.data.montageId, isFinalAttempt);
    },
    { connection: redisConnection(), concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[worker] render-montage job ${job?.id} failed:`, err.message);
  });
  return worker;
}

// Running this file directly boots the worker process (queue consumers).
if (import.meta.url === `file://${process.argv[1]}`) {
  const mediaWorker = startMediaWorker();
  const renderWorker = startRenderWorker();
  // eslint-disable-next-line no-console
  console.log('@twenty4/worker: media-validation + montage-render workers running.');

  const shutdown = async (): Promise<void> => {
    await mediaWorker.close();
    await renderWorker.close();
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
