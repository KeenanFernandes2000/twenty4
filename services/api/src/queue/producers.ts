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

/* ---------------------------- montage queue ------------------------------- */

/** Queue + job names for the render pipeline + §6 montage-lifecycle jobs. */
export const MONTAGE_QUEUE = 'montage';
export const RENDER_MONTAGE_JOB = 'render-montage';
export const EXPIRE_MONTAGE_JOB = 'expire-montage';
export const CLEANUP_RAW_JOB = 'cleanup-raw';
/** Replace cascade (§6 Q2): hard-delete the prior (superseded) montage's content. */
export const SUPERSEDE_CLEANUP_JOB = 'supersede-cleanup';

/**
 * Payload for the `render-montage` job. Only the montage id is needed — the worker
 * re-reads the canonical row + the user's VALID media for the day_bucket, so it's
 * self-contained and can't act on stale client-passed values (theme/music live on
 * the row, set by the API at generate/regenerate time).
 */
export interface RenderMontageJob {
  montageId: string;
}

/** Payload for the delayed `expire-montage` job (§6 24h expiry — consumer Slice 7). */
export interface ExpireMontageJob {
  montageId: string;
  /** ISO of the scheduled expiry (= published_at + 24h). */
  expiryAt: string;
}

/** Payload for the delayed `cleanup-raw` job (§6 Q5 — raw purge, consumer Slice 7). */
export interface CleanupRawJob {
  userId: string;
  dayBucket: string;
  /** The montage whose publish triggered the purge (audit context). */
  montageId: string;
}

/**
 * Payload for the `supersede-cleanup` job (§6 Q2 replace cascade). Hard-deletes the
 * PRIOR (superseded) montage's content — S3 video+thumb, row, cascade reactions/
 * comments/visibility, tombstone. `replacementId` is audit context (the new live
 * montage). The worker consumer is idempotent (already-gone → no-op).
 */
export interface SupersedeCleanupJob {
  priorMontageId: string;
  replacementId: string;
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

/* --------------------------- montage producers ----------------------------- */

let _montageQueue: Queue | null = null;

/** Lazily construct the montage queue (render + lifecycle jobs share one queue). */
function montageQueue(): Queue {
  if (!_montageQueue) {
    _montageQueue = new Queue(MONTAGE_QUEUE, { connection: redisConnection() });
  }
  return _montageQueue;
}

/**
 * Enqueue a `render-montage` job (called by POST /montages + regenerate/replace).
 * The worker loads the row + the user's VALID media, builds the EDL, renders the
 * MP4 + thumbnail, uploads them, and flips status → draft_ready (or failed).
 *
 * §7.4: `attempts:2` (one retry); on final failure the worker marks the row failed
 * and cleans up any partial S3 (no orphans). A 5-min hard timeout is enforced by
 * the renderer itself; we also cap job lifetime generously here.
 */
export async function enqueueRenderMontage(
  payload: RenderMontageJob,
): Promise<string> {
  const job = await montageQueue().add(RENDER_MONTAGE_JOB, payload, {
    removeOnComplete: true,
    removeOnFail: 100,
    attempts: 2,
    backoff: { type: 'fixed', delay: 2000 },
  });
  return job.id!;
}

/**
 * Enqueue the DELAYED `expire-montage` job at +24h (§6). The CONSUMER is Slice 7
 * (deletion lifecycle); here we only schedule it so the delayed job already exists
 * when the consumer is wired. A repeatable sweep (belt-and-suspenders) is also
 * Slice 7. // TODO(slice 7): consume `expire-montage` → delete video/thumb + row +
 * cascade reactions/comments + audit tombstone.
 */
export async function enqueueExpireMontage(
  payload: ExpireMontageJob,
  delayMs: number,
): Promise<void> {
  await montageQueue().add(EXPIRE_MONTAGE_JOB, payload, {
    // Deterministic jobId so re-publish/replay can't double-schedule the same
    // expiry. NOTE: BullMQ custom jobIds may NOT contain ':' — use '-' separators.
    jobId: `expire-${payload.montageId}`,
    delay: Math.max(0, delayMs),
    removeOnComplete: true,
    removeOnFail: 100,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

/**
 * Remove a previously-scheduled `expire-montage` job by its deterministic jobId
 * (see `enqueueExpireMontage`). Used on REPLACE: when a prior published montage is
 * superseded, its pending +24h expiry job would otherwise still fire on a montage
 * that's already gone (an orphan). Best-effort + idempotent — a missing job (never
 * scheduled, already fired, or already removed) is a no-op.
 */
export async function removeExpireMontage(montageId: string): Promise<void> {
  try {
    const job = await montageQueue().getJob(`expire-${montageId}`);
    if (job) await job.remove();
  } catch {
    // Slice 7's idempotent expiry sweep is the backstop if removal fails here.
  }
}

/**
 * Schedule the delayed `cleanup-raw` job at +60min (§6 Q5 — raw purge after
 * publish). CONSUMER is Slice 7. // TODO(slice 7): consume `cleanup-raw` →
 * hard-delete ALL raw (used + unused) + draft renders for (user, day_bucket).
 */
export async function enqueueCleanupRaw(
  payload: CleanupRawJob,
  delayMs: number,
): Promise<void> {
  await montageQueue().add(CLEANUP_RAW_JOB, payload, {
    // BullMQ custom jobIds may NOT contain ':' — use '-' separators.
    jobId: `cleanup-raw-${payload.userId}-${payload.dayBucket}`,
    delay: Math.max(0, delayMs),
    removeOnComplete: true,
    removeOnFail: 100,
    attempts: 5,
    backoff: { type: 'exponential', delay: 10000 },
  });
}

/**
 * Enqueue the `supersede-cleanup` job (§6 Q2). Called by POST /montages/:id/replace
 * AFTER the replacement is published + the prior is marked superseded — the worker
 * hard-deletes the prior montage's content (S3 + row + cascade social + tombstone).
 * Deterministic jobId so a replay can't double-schedule; the consumer is idempotent
 * regardless. No delay — the prior render should be gone promptly on replacement.
 */
export async function enqueueSupersedeCleanup(
  payload: SupersedeCleanupJob,
): Promise<void> {
  await montageQueue().add(SUPERSEDE_CLEANUP_JOB, payload, {
    jobId: `supersede-${payload.priorMontageId}`,
    removeOnComplete: true,
    removeOnFail: 100,
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

/* ------------------------------ ops / metrics ------------------------------ */

/** Per-queue BullMQ job-state counts (Slice 8 admin ops). */
export interface QueueJobCounts {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

/**
 * Read job-state counts for every known queue (account / media / montage). Used by
 * `GET /admin/ops` to surface failed-job counts per queue (and the rest). Opens a
 * short-lived Queue per name so it never touches the lazily-constructed producer
 * singletons; each is closed before returning. Best-effort: a Redis error on one
 * queue yields zeros for that queue rather than failing the whole ops call.
 */
export async function getQueueCounts(): Promise<QueueJobCounts[]> {
  const names = [ACCOUNT_QUEUE, MEDIA_QUEUE, MONTAGE_QUEUE];
  const out: QueueJobCounts[] = [];
  for (const name of names) {
    const q = new Queue(name, { connection: redisConnection() });
    try {
      const counts = await q.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );
      out.push({
        name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      });
    } catch {
      out.push({ name, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
    } finally {
      await q.close().catch(() => undefined);
    }
  }
  return out;
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
  if (_montageQueue) {
    await _montageQueue.close();
    _montageQueue = null;
  }
}
