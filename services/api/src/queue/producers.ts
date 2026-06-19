/**
 * BullMQ producers (enqueue-only).
 *
 * Slice 3 needs exactly one producer: `purge-account`, enqueued by
 * DELETE /users/me after sessions are revoked. The worker job is a LATER slice —
 * here we only define the queue + an enqueue helper (TODO: worker consumer).
 *
 * Uses the shared ioredis connection. BullMQ requires `maxRetriesPerRequest:null`
 * on its connection; the shared health client sets it to 1, so we pass a dedicated
 * connection options object (BullMQ creates its own client from it).
 */
import { Queue } from 'bullmq';
import { env } from '../env.js';

/** Parse REDIS_URL into BullMQ connection options. */
function redisConnection(): { host: string; port: number; maxRetriesPerRequest: null } {
  const u = new URL(env.REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    maxRetriesPerRequest: null,
  };
}

export const ACCOUNT_QUEUE = 'account';

/** Payload for the account purge job (§5 account-delete purges immediately). */
export interface PurgeAccountJob {
  userId: string;
  /** When the deletion was requested (for audit/SLA). */
  requestedAt: string;
}

/* --------------------------- validate-media queue -------------------------- */

/** Queue + job name for the §6 metadata-validation hierarchy. */
export const MEDIA_QUEUE = 'media';
export const VALIDATE_MEDIA_JOB = 'validate-media';

/**
 * Payload for the `validate-media` job. Only the media row id is needed — the
 * worker re-reads the canonical row (storage key, content-type, day_bucket,
 * device tz/clock, captured_in_app) so it's self-contained and can't act on
 * stale client-passed values. `serverReceiveTime` anchors the anti-tamper delta
 * to when the SERVER accepted the upload completion.
 */
export interface ValidateMediaJob {
  mediaId: string;
  serverReceiveTime: string;
}

let _accountQueue: Queue<PurgeAccountJob> | null = null;

/** Lazily construct the account queue (avoids a Redis connection at import time). */
function accountQueue(): Queue<PurgeAccountJob> {
  if (!_accountQueue) {
    _accountQueue = new Queue<PurgeAccountJob>(ACCOUNT_QUEUE, {
      connection: redisConnection(),
    });
  }
  return _accountQueue;
}

/**
 * Enqueue a `purge-account` job. The worker (later slice) hard-deletes the user's
 * content + row to the §6 promise; here we only enqueue.
 */
export async function enqueuePurgeAccount(payload: PurgeAccountJob): Promise<void> {
  // TODO(worker slice): consume `purge-account` → cascade-delete media/montages/
  // social/groups, then the users row; write an audit tombstone.
  await accountQueue().add('purge-account', payload, {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

let _mediaQueue: Queue<ValidateMediaJob> | null = null;

/** Lazily construct the media queue. */
function mediaQueue(): Queue<ValidateMediaJob> {
  if (!_mediaQueue) {
    _mediaQueue = new Queue<ValidateMediaJob>(MEDIA_QUEUE, {
      connection: redisConnection(),
    });
  }
  return _mediaQueue;
}

/**
 * Enqueue a `validate-media` job (called by POST /media/:id/complete after the
 * client has PUT the raw object). The worker runs the §6 validation hierarchy and
 * sets `validation_status` + flags. Retries a couple times (transient S3/network),
 * but the worker also never crashes the process on a bad item — it marks invalid.
 */
export async function enqueueValidateMedia(payload: ValidateMediaJob): Promise<void> {
  await mediaQueue().add(VALIDATE_MEDIA_JOB, payload, {
    removeOnComplete: true,
    removeOnFail: 100,
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

/** Close the queue connection (graceful shutdown). */
export async function closeQueues(): Promise<void> {
  if (_accountQueue) {
    await _accountQueue.close();
    _accountQueue = null;
  }
  if (_mediaQueue) {
    await _mediaQueue.close();
    _mediaQueue = null;
  }
}
