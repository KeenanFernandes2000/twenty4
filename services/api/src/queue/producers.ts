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

/** Close the queue connection (graceful shutdown). */
export async function closeQueues(): Promise<void> {
  if (_accountQueue) {
    await _accountQueue.close();
    _accountQueue = null;
  }
}
