// BullMQ queue wiring for validate-media (M4 §5).
//
// Shared constants + connection helpers used by BOTH the API (enqueue side) and
// the worker (process side). The queue name and jobId convention live here so the
// two sides never disagree.
//
// jobId convention: `media-<id>` — NEVER contains ':' (the v1 §5 lesson: a ':' in
// a BullMQ custom jobId silently breaks delayed scheduling). Also makes /complete
// idempotent: a re-enqueue with the same jobId is deduped by BullMQ.
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { ValidateMediaJobData } from "./validateMedia.ts";

export const VALIDATE_MEDIA_QUEUE = "validate-media";

export function validateMediaJobId(mediaId: string): string {
  return `media-${mediaId}`;
}

// BullMQ wants host/port (or a URL). Parse REDIS_URL into a connection.
export function redisConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    // BullMQ requires this be null for blocking commands.
    maxRetriesPerRequest: null,
  };
}

export function createValidateMediaQueue(redisUrl: string): Queue<ValidateMediaJobData> {
  return new Queue<ValidateMediaJobData>(VALIDATE_MEDIA_QUEUE, { connection: redisConnection(redisUrl) });
}

export { Worker };
