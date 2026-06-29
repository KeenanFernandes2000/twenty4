// Cleanup / ephemerality queue contract (M9 §2/§3) — the SINGLE source of truth
// for the deletion-pipeline queue names + jobId formatters that the API (enqueue)
// and worker (consume) both import.
//
// THE #1 HISTORICAL GOTCHA (recap §5/§8.10): a BullMQ custom jobId containing a
// ':' SILENTLY breaks delayed-job scheduling — which IS the 24h-expiry mechanism.
// Every jobId is built here with '-' separators and run through `assertNoColon`
// so the rule is enforced centrally, not re-derived (and re-broken) per call site.

// ── Authoritative (one-shot) job queues ──────────────────────────────────────
export const EXPIRE_MONTAGE_QUEUE = "expire-montage";
export const RAW_PURGE_QUEUE = "raw-purge";
export const PURGE_ACCOUNT_QUEUE = "purge-account";
export const DELETE_MONTAGE_QUEUE = "delete-montage";

// ── Defense-in-depth repeatable reclaim sweeps ───────────────────────────────
export const SWEEP_EXPIRIES_QUEUE = "sweep-expiries";
export const RAW_PURGE_SWEEP_QUEUE = "raw-purge-sweep";
export const DAY_CLOSE_SWEEP_QUEUE = "day-close-sweep";
export const SNAPSHOT_PURGE_SWEEP_QUEUE = "snapshot-purge-sweep";

/**
 * Defensive guard: a BullMQ jobId must NOT contain ':' (it silently breaks
 * delayed-job scheduling). Throws if violated; returns the id unchanged so it can
 * wrap a formatter's return inline.
 */
export function assertNoColon(jobId: string): string {
  if (jobId.includes(":")) {
    throw new Error(`BullMQ jobId must not contain ':' (breaks delayed scheduling): ${jobId}`);
  }
  return jobId;
}

// ── jobId formatters (all '-' separated, all guarded) ────────────────────────
// Delayed expire job for a published montage (jobId stable per montage so a
// re-publish/replace can target-cancel it).
export function expireMontageJobId(montageId: string): string {
  return assertNoColon(`expire-montage-${montageId}`);
}

// +60-min raw-purge after a successful publish, keyed on montage + day_bucket.
export function rawPurgeJobId(montageId: string, dayBucket: string): string {
  return assertNoColon(`raw-purge-${montageId}-${dayBucket}`);
}

// Immediate account purge on DELETE /users/me, keyed on the user.
export function purgeAccountJobId(userId: string): string {
  return assertNoColon(`purge-account-${userId}`);
}

// Manual hard-delete (DELETE /montages/:id), keyed on the montage.
export function deleteMontageJobId(montageId: string): string {
  return assertNoColon(`delete-montage-${montageId}`);
}
