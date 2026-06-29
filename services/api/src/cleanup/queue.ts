// API-side enqueue for the M9 ephemerality / hard-delete pipeline. The API only
// ADDs jobs; the worker package owns the processors (deleteMontageHard /
// purgeRawMedia / purge-account + the reclaim sweeps). We deliberately do NOT
// import the worker package — only the cross-team queue contract from
// @twenty4/contracts (the single source of truth for queue names + jobId
// formatters, every id '-'-separated; a ':' silently breaks BullMQ delayed
// scheduling, which IS the 24h-expiry mechanism — recap §5/§8.10).
import { Queue, type ConnectionOptions } from "bullmq";
import {
  DELETE_MONTAGE_QUEUE,
  EXPIRE_MONTAGE_QUEUE,
  PURGE_ACCOUNT_QUEUE,
  RAW_PURGE_QUEUE,
  deleteMontageJobId,
  expireMontageJobId,
  purgeAccountJobId,
  rawPurgeJobId,
  // M9 cross-team job-data contract (single source of truth — the worker parses
  // these same schemas on receipt, so a field-name drift is a parse error here).
  deleteMontageJobDataSchema,
  expireMontageJobDataSchema,
  purgeAccountJobDataSchema,
  rawPurgeJobDataSchema,
  type CleanupReason,
  type DeleteMontageJobData,
  type ExpireMontageJobData,
  type PurgeAccountJobData,
  type RawPurgeJobData,
} from "@twenty4/contracts";

// Job-data shapes are owned by @twenty4/contracts (cleanupJobs.ts); re-exported here
// for callers that import them off the enqueue module.
export type {
  DeleteMontageJobData,
  ExpireMontageJobData,
  PurgeAccountJobData,
  RawPurgeJobData,
};

// The set of one-shot cleanup queues the API enqueues onto.
export interface CleanupQueues {
  expireMontage: Queue<ExpireMontageJobData>;
  rawPurge: Queue<RawPurgeJobData>;
  purgeAccount: Queue<PurgeAccountJobData>;
  deleteMontage: Queue<DeleteMontageJobData>;
}

function redisConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null };
}

// Build the four cleanup queues. `nameSuffix` lets tests isolate the queue names
// (e.g. `-test-<pid>-<seq>`) so no running prod worker drains the enqueues under
// inspection — mirrors makeMontageQueue. The worker boots with no suffix (the
// canonical names the contract pins).
export function createCleanupQueues(redisUrl: string, nameSuffix = ""): CleanupQueues {
  const connection = redisConnection(redisUrl);
  return {
    expireMontage: new Queue<ExpireMontageJobData>(EXPIRE_MONTAGE_QUEUE + nameSuffix, { connection }),
    rawPurge: new Queue<RawPurgeJobData>(RAW_PURGE_QUEUE + nameSuffix, { connection }),
    purgeAccount: new Queue<PurgeAccountJobData>(PURGE_ACCOUNT_QUEUE + nameSuffix, { connection }),
    deleteMontage: new Queue<DeleteMontageJobData>(DELETE_MONTAGE_QUEUE + nameSuffix, { connection }),
  };
}

export async function closeCleanupQueues(queues: CleanupQueues | undefined): Promise<void> {
  if (!queues) return;
  await Promise.all([
    queues.expireMontage.close(),
    queues.rawPurge.close(),
    queues.purgeAccount.close(),
    queues.deleteMontage.close(),
  ]);
}

// removeOnComplete/Fail keep the queues lean; a re-add under the same deterministic
// jobId is deduped (idempotent enqueue) and lets a re-publish/replace target-cancel
// the delayed expire job. All helpers tolerate an undefined queue set (an M1-only
// app, or a test that wires none) — mirrors enqueueRenderMontage's robustness.
const ONE_SHOT_OPTS = { removeOnComplete: true, removeOnFail: true } as const;

// Delayed expire-montage. `delayMs` = time-until-expiry; the DELAY *is* the 24h
// (shortened-in-test) hard-delete clock. jobId stable per montage → cancellable.
export async function enqueueExpireMontage(
  queues: CleanupQueues | undefined,
  montageId: string,
  delayMs: number,
): Promise<void> {
  if (!queues) return;
  const data = expireMontageJobDataSchema.parse({ montageId });
  await queues.expireMontage.add(
    "expire",
    data,
    { jobId: expireMontageJobId(montageId), delay: Math.max(0, Math.floor(delayMs)), ...ONE_SHOT_OPTS },
  );
}

// Delayed raw-media purge keyed on montage + day_bucket (the +grace job).
export async function enqueueRawPurge(
  queues: CleanupQueues | undefined,
  args: { montageId: string; dayBucket: string; userId: string; delayMs: number; reason?: CleanupReason },
): Promise<void> {
  if (!queues) return;
  const reason = args.reason ?? "published_grace";
  const data = rawPurgeJobDataSchema.parse({
    montageId: args.montageId,
    dayBucket: args.dayBucket,
    userId: args.userId,
    reason,
  });
  await queues.rawPurge.add(
    "raw-purge",
    data,
    { jobId: rawPurgeJobId(args.montageId, args.dayBucket), delay: Math.max(0, Math.floor(args.delayMs)), ...ONE_SHOT_OPTS },
  );
}

// Immediate account purge (DELETE /users/me); the worker drains it asap.
export async function enqueuePurgeAccount(
  queues: CleanupQueues | undefined,
  userId: string,
): Promise<void> {
  if (!queues) return;
  const data = purgeAccountJobDataSchema.parse({ userId });
  await queues.purgeAccount.add(
    "purge-account",
    data,
    { jobId: purgeAccountJobId(userId), ...ONE_SHOT_OPTS },
  );
}

// Immediate hard-delete of one montage (manual delete, or replace-completion).
export async function enqueueDeleteMontage(
  queues: CleanupQueues | undefined,
  montageId: string,
  reason: CleanupReason,
): Promise<void> {
  if (!queues) return;
  const data = deleteMontageJobDataSchema.parse({ montageId, reason });
  await queues.deleteMontage.add(
    "delete-montage",
    data,
    { jobId: deleteMontageJobId(montageId), ...ONE_SHOT_OPTS },
  );
}

// Best-effort cancel of a montage's delayed expire job (replace-completion). The
// sweep is the authoritative backstop (§6 regression #1), so a miss is harmless.
export async function cancelExpireMontage(
  queues: CleanupQueues | undefined,
  montageId: string,
): Promise<void> {
  if (!queues) return;
  try {
    const job = await queues.expireMontage.getJob(expireMontageJobId(montageId));
    if (job) await job.remove();
  } catch {
    /* best-effort — the sweep reclaims a superseded montage regardless */
  }
}
