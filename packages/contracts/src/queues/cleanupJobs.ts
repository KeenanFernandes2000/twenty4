// Cleanup job-DATA payload contracts (M9) — the SINGLE source of truth for the
// `job.data` FIELD NAMES the API enqueues and the worker consumes. cleanup.ts owns
// the queue NAMES + jobId formatters; THIS file owns the PAYLOAD shapes so a
// field-name drift between the two services (e.g. API sends `montageId`, worker
// reads `recapId`) is a parse/compile error — never a silent 24h-expiry no-op that
// leaves BOTH suites green while production cleanup quietly fails.
//
// Wiring: the API enqueue helpers `.parse()` before `.add()`; the worker processors
// `.parse()` on receipt. The required field set is exactly what the worker
// primitives need; optional fields are audit context the API carries.
import { z } from "zod";

// The CLOSED set of cleanup reason-codes the pipeline writes into a tombstone's
// `reason`. A z.enum (NOT an open z.string()) so a future caller can NEVER land
// user-typed free text in a content-free tombstone — the domain is pinned to these
// exact codes the primitives/sweeps pass:
//   one-shot deletes:  expired / replaced / deleted_by_user / account_deleted
//   raw purges:        published_grace / window_closed
//   reclaim sweeps:    swept_expired / swept_orphan_draft
// (snapshot-purge writes its OWN action `report.snapshot_purged` and never a
//  `reason`, so it is intentionally NOT a member here.)
export const CLEANUP_REASONS = [
  "expired",
  "replaced",
  "deleted_by_user",
  "account_deleted",
  "published_grace",
  "window_closed",
  "swept_expired",
  "swept_orphan_draft",
] as const;
export const cleanupReasonSchema = z.enum(CLEANUP_REASONS);
export type CleanupReason = z.infer<typeof cleanupReasonSchema>;

// expire-montage (delayed): worker hard-deletes this montage on fire. Needs id only.
export const expireMontageJobDataSchema = z.object({
  montageId: z.string().uuid(),
});
export type ExpireMontageJobData = z.infer<typeof expireMontageJobDataSchema>;

// raw-purge (delayed +grace): worker purges this user's (user, dayBucket) raw slice.
// userId + dayBucket are LOAD-BEARING (the purgeRawMedia filter). montageId + reason
// are audit context the API includes — OPTIONAL so a leaner direct call still parses.
export const rawPurgeJobDataSchema = z.object({
  userId: z.string().uuid(),
  dayBucket: z.string().min(1),
  montageId: z.string().uuid().optional(),
  reason: cleanupReasonSchema.optional(),
});
export type RawPurgeJobData = z.infer<typeof rawPurgeJobDataSchema>;

// purge-account (immediate): cascade-delete all of this user's content. Needs id only.
export const purgeAccountJobDataSchema = z.object({
  userId: z.string().uuid(),
});
export type PurgeAccountJobData = z.infer<typeof purgeAccountJobDataSchema>;

// delete-montage (immediate): hard-delete this montage. reason OPTIONAL (the worker
// falls back to 'deleted_by_user').
export const deleteMontageJobDataSchema = z.object({
  montageId: z.string().uuid(),
  reason: cleanupReasonSchema.optional(),
});
export type DeleteMontageJobData = z.infer<typeof deleteMontageJobDataSchema>;
