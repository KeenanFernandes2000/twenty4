// BullMQ queue wiring for render-montage (M7 §3). The FIXED cross-team contract the
// API agent enqueues to: queue name `render-montage`, job data `{ montageId }`,
// custom jobId `montage-<id>`, attempts: 2 (one auto-retry), removeOnComplete/Fail
// true (the outcome is persisted on the montage row; freeing the jobId so regenerate
// can re-enqueue).
//
// jobId convention: `montage-<id>` — NEVER contains ':' (the §8.10 lesson: a ':' in
// a BullMQ custom jobId silently breaks delayed scheduling, which M9's 24h expiry
// relies on).
import { Queue } from "bullmq";
import { redisConnection } from "../queue.ts";

export const RENDER_MONTAGE_QUEUE = "render-montage";

export interface RenderMontageJobData {
  montageId: string;
}

export function renderMontageJobId(montageId: string): string {
  return `montage-${montageId}`;
}

export function createRenderMontageQueue(redisUrl: string): Queue<RenderMontageJobData> {
  return new Queue<RenderMontageJobData>(RENDER_MONTAGE_QUEUE, {
    connection: redisConnection(redisUrl),
  });
}
