// API-side enqueue for render-montage (M7). The API only ADDs jobs; the worker
// package owns the render processor. We keep the queue name + jobId convention
// here in lockstep with the cross-team queue contract (deliberately NOT importing
// the worker package, to avoid pulling Remotion/essentia deps into the API).
//
// jobId = `montage-<id>` — NEVER contains ':' (v1 §5/§8.10: a ':' silently breaks
// BullMQ delayed scheduling, the exact mechanism M9's 24h expiry relies on) AND
// makes generate/regenerate idempotent (a re-add with the same jobId is deduped).
import { Queue, type ConnectionOptions } from "bullmq";

export const RENDER_MONTAGE_QUEUE = "render-montage";

export interface RenderMontageJobData {
  montageId: string;
}

export function renderMontageJobId(montageId: string): string {
  return `montage-${montageId}`;
}

function redisConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null };
}

export function createRenderMontageQueue(redisUrl: string): Queue<RenderMontageJobData> {
  return new Queue<RenderMontageJobData>(RENDER_MONTAGE_QUEUE, { connection: redisConnection(redisUrl) });
}

// Enqueue a render-montage job. Idempotent via the deterministic jobId (`montage-
// <id>`). attempts=2 = one auto-retry (the worker's render-failure contract);
// removeOnComplete/Fail keep the queue clean (a re-enqueue under the same jobId is
// free once the prior job is gone). Tolerates an undefined queue (a guard for the
// rare test that wires no queue — mirrors the media enqueue-side robustness).
export async function enqueueRenderMontage(
  queue: Queue<RenderMontageJobData> | undefined,
  montageId: string,
): Promise<void> {
  if (!queue) return;
  await queue.add(
    "render",
    { montageId },
    {
      jobId: renderMontageJobId(montageId),
      attempts: 2,
      removeOnComplete: true,
      removeOnFail: true,
      backoff: { type: "exponential", delay: 1000 },
    },
  );
}
