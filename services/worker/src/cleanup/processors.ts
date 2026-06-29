// M9 cleanup — BullMQ job processors. Thin adapters from job data → the reused
// primitives/sweeps. Exported so the §6 suite drives them DIRECTLY (synchronous,
// no spawned worker), exactly like the validate-media / render-montage tests.
import {
  deleteMontageJobDataSchema,
  expireMontageJobDataSchema,
  purgeAccountJobDataSchema,
  rawPurgeJobDataSchema,
} from "@twenty4/contracts";
import type { CleanupDeps } from "./primitives.ts";
import { deleteMontageHard, purgeAccount, purgeRawMedia } from "./primitives.ts";
import { sweepDayClose, sweepExpiries, sweepRawPurge, sweepSnapshotPurge } from "./sweeps.ts";

// ── one-shot job data shapes ────────────────────────────────────────────────────
// Owned by @twenty4/contracts (cleanupJobs.ts) — the SAME schemas the API enqueues
// with. Re-exported so the queue wiring (./queue.ts) can type its Workers off them.
// Each processor `.parse()`s `job.data` on receipt: a field-name drift from the API
// throws LOUDLY (the job fails + retries) instead of silently reading `undefined`
// and no-op'ing the whole 24h-expiry pipeline.
export type {
  ExpireMontageJobData,
  RawPurgeJobData,
  PurgeAccountJobData,
  DeleteMontageJobData,
} from "@twenty4/contracts";

// expire-montage (delayed): fire-and-converge. No-op if the montage is already
// gone / was superseded-and-reclaimed.
export async function processExpireMontage(deps: CleanupDeps, data: unknown) {
  const { montageId } = expireMontageJobDataSchema.parse(data);
  return deleteMontageHard(deps, montageId, "expired");
}

// raw-purge (delayed +grace): purge the published recap's whole day bucket.
export async function processRawPurge(deps: CleanupDeps, data: unknown) {
  const { userId, dayBucket } = rawPurgeJobDataSchema.parse(data);
  return purgeRawMedia(deps, { userId, dayBucket }, "published_grace");
}

// purge-account (immediate): cascade-delete all of a user's content.
export async function processPurgeAccount(deps: CleanupDeps, data: unknown) {
  const { userId } = purgeAccountJobDataSchema.parse(data);
  return purgeAccount(deps, userId, "account_deleted");
}

// delete-montage (immediate): manual DELETE /montages/:id + replace's prior-delete.
export async function processDeleteMontage(deps: CleanupDeps, data: unknown) {
  const { montageId, reason } = deleteMontageJobDataSchema.parse(data);
  return deleteMontageHard(deps, montageId, reason ?? "deleted_by_user");
}

// ── repeatable sweep processors (no job data) ──────────────────────────────────
export async function processSweepExpiries(deps: CleanupDeps) {
  return sweepExpiries(deps);
}
export async function processRawPurgeSweep(deps: CleanupDeps) {
  return sweepRawPurge(deps);
}
export async function processDayCloseSweep(deps: CleanupDeps) {
  return sweepDayClose(deps);
}
export async function processSnapshotPurgeSweep(deps: CleanupDeps) {
  return sweepSnapshotPurge(deps);
}
