// API-side enqueue for validate-media (M4). The API only ADDs jobs; the worker
// package owns the processor. We keep the queue name + jobId convention here in
// lockstep with services/worker/src/queue.ts (deliberately NOT importing the
// worker package, to avoid pulling its ffprobe/exifr deps into the API).
//
// jobId = `media-<id>` — NEVER contains ':' (v1 §5: a ':' silently breaks BullMQ
// delayed scheduling) AND makes /complete idempotent (re-add with same jobId is
// deduped by BullMQ).
import { Queue, type ConnectionOptions } from "bullmq";

export const VALIDATE_MEDIA_QUEUE = "validate-media";

export interface ValidateMediaJobData {
  mediaId: string;
}

export function validateMediaJobId(mediaId: string): string {
  return `media-${mediaId}`;
}

function redisConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null };
}

export function createValidateMediaQueue(redisUrl: string): Queue<ValidateMediaJobData> {
  return new Queue<ValidateMediaJobData>(VALIDATE_MEDIA_QUEUE, { connection: redisConnection(redisUrl) });
}

// Enqueue a validate-media job. Idempotent via the deterministic jobId.
export async function enqueueValidateMedia(
  queue: Queue<ValidateMediaJobData>,
  mediaId: string,
): Promise<void> {
  await queue.add(
    "validate",
    { mediaId },
    {
      jobId: validateMediaJobId(mediaId),
      removeOnComplete: true,
      removeOnFail: false,
      // HIGH-4: retry transient DB/S3 failures so a blip doesn't leave a row stuck
      // in `validating`. On final exhaustion the processor's catch-all (see
      // validateMedia.ts) has already marked the row terminal (`failed`).
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    },
  );
}
