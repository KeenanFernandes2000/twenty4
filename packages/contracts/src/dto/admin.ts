// Admin DTOs (M9 thin admin §2/§5) — read-only response contracts for the
// lost-cleanup-job view + a storage/count aggregate. The full moderation/admin
// console is M12; M9 ships only enough to *see* a dropped cleanup job and the
// live content footprint. Single source of truth; the API + api-client import.
import { z } from "zod";

// One failed/lost cleanup job (content-free — ids + the engine's error string,
// never montage media/comment/reaction content).
export const cleanupJobDtoSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  failedReason: z.string().nullable(),
  attemptsMade: z.number().int(),
});
export type CleanupJobDTO = z.infer<typeof cleanupJobDtoSchema>;

// Per-queue failed/delayed counts + a capped sample of the failed jobs.
export const cleanupQueueStatusSchema = z.object({
  queue: z.string(),
  failed: z.number().int(),
  delayed: z.number().int(),
  jobs: z.array(cleanupJobDtoSchema),
});
export type CleanupQueueStatus = z.infer<typeof cleanupQueueStatusSchema>;

// GET /admin/cleanup-jobs — read-only failed/lost cleanup-job list.
export const cleanupJobsResSchema = z.object({
  queues: z.array(cleanupQueueStatusSchema),
});
export type CleanupJobsRes = z.infer<typeof cleanupJobsResSchema>;

// GET /admin/storage-usage — read-only live-content footprint (row counts; S3
// object counts are optional/out-of-scope for the thin M9 view).
export const storageUsageResSchema = z.object({
  liveMontages: z.number().int(),
  publishedMontages: z.number().int(),
  rawMediaItems: z.number().int(),
  reactions: z.number().int(),
  comments: z.number().int(),
});
export type StorageUsageRes = z.infer<typeof storageUsageResSchema>;
