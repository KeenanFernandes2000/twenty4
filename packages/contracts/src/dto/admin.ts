/**
 * Admin DTOs (§8 Admin, internal): user search/summary · suspend/ban · view
 * groups · review reports · remove content · processing/failed-job status ·
 * storage usage · growth metrics. Minimal for the Phase-1 admin shell.
 *
 * // TODO(spec-gap): §8 lists admin as a resource map only; payloads below are
 * reasonable shapes for the minimal moderation/ops console (PLAN slice 8).
 */
import { z } from 'zod';
import {
  accountStatusSchema,
  reportReasonSchema,
  reportStatusSchema,
  reportTargetTypeSchema,
} from '../enums.js';
import { cursorPaginationSchema, pageSchema, userSummarySchema } from './_common.js';

/* ------------------------------- user admin -------------------------------- */
export const adminUserSearchQuerySchema = z
  .object({
    q: z.string().min(1).optional(),
    status: accountStatusSchema.optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type AdminUserSearchQuery = z.infer<typeof adminUserSearchQuerySchema>;

export const adminUserSummarySchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string(),
    username: z.string(),
    accountStatus: accountStatusSchema,
    groupCount: z.number().int().min(0),
    montageCount: z.number().int().min(0),
    reportCount: z.number().int().min(0),
    createdAt: z.string(),
  })
  .strict();
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const adminUserListResponseSchema = pageSchema(adminUserSummarySchema);
export type AdminUserListResponse = z.infer<typeof adminUserListResponseSchema>;

/** Suspend/ban an account. */
export const adminModerateUserRequestSchema = z
  .object({
    action: z.enum(['suspend', 'ban', 'reinstate']),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type AdminModerateUserRequest = z.infer<typeof adminModerateUserRequestSchema>;

/* -------------------------------- reports ---------------------------------- */
export const adminReportQuerySchema = z
  .object({
    status: reportStatusSchema.optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type AdminReportQuery = z.infer<typeof adminReportQuerySchema>;

export const adminReportSchema = z
  .object({
    id: z.string().uuid(),
    reporter: userSummarySchema,
    targetType: reportTargetTypeSchema,
    targetId: z.string().uuid(),
    reason: reportReasonSchema,
    status: reportStatusSchema,
    createdAt: z.string(),
  })
  .strict();
export type AdminReport = z.infer<typeof adminReportSchema>;

export const adminReportListResponseSchema = pageSchema(adminReportSchema);
export type AdminReportListResponse = z.infer<typeof adminReportListResponseSchema>;

/**
 * Action a report (§8 review reports). The `action` chooses the moderation
 * outcome; `dismiss` closes with no effect, the others close the report AND
 * apply the side-effect to the target (remove the reported content, or
 * suspend/ban the target/owner). `note` is a content-free admin note.
 */
export const REPORT_RESOLVE_ACTIONS = [
  'dismiss',
  'remove_content',
  'suspend_user',
  'ban_user',
] as const;
export const reportResolveActionSchema = z.enum(REPORT_RESOLVE_ACTIONS);
export type ReportResolveAction = z.infer<typeof reportResolveActionSchema>;

export const adminResolveReportRequestSchema = z
  .object({
    action: reportResolveActionSchema,
    note: z.string().max(500).optional(),
  })
  .strict();
export type AdminResolveReportRequest = z.infer<typeof adminResolveReportRequestSchema>;

/** Response after resolving a report. */
export const adminResolveReportResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: reportStatusSchema,
    action: reportResolveActionSchema,
    /** Whether the reported content was removed as part of this resolution. */
    contentRemoved: z.boolean(),
  })
  .strict();
export type AdminResolveReportResponse = z.infer<typeof adminResolveReportResponseSchema>;

/** Remove a montage / comment as an admin (§8 remove content). */
export const adminRemoveContentRequestSchema = z
  .object({ reason: z.string().max(500).optional() })
  .strict();
export type AdminRemoveContentRequest = z.infer<typeof adminRemoveContentRequestSchema>;

/* ----------------------------- ops / metrics ------------------------------- */
export const adminJobStatusQuerySchema = cursorPaginationSchema.extend({
  state: z.enum(['failed', 'active', 'completed', 'delayed', 'waiting']).optional(),
});
export type AdminJobStatusQuery = z.infer<typeof adminJobStatusQuerySchema>;

export const adminStorageUsageResponseSchema = z
  .object({
    rawBytes: z.number().int().min(0),
    montageBytes: z.number().int().min(0),
    thumbnailBytes: z.number().int().min(0),
    totalBytes: z.number().int().min(0),
  })
  .strict();
export type AdminStorageUsageResponse = z.infer<typeof adminStorageUsageResponseSchema>;

export const adminGrowthMetricsResponseSchema = z
  .object({
    dau: z.number().int().min(0),
    totalUsers: z.number().int().min(0),
    totalGroups: z.number().int().min(0),
    montagesPublishedToday: z.number().int().min(0),
    renderFailureRate: z.number().min(0).max(1),
  })
  .strict();
export type AdminGrowthMetricsResponse = z.infer<typeof adminGrowthMetricsResponseSchema>;

/**
 * Consolidated ops dashboard (§8 / PLAN slice 8 `GET /admin/ops`): per-queue
 * BullMQ job-state counts (esp. failed), per-bucket S3 storage usage, and basic
 * growth/health metrics. All counts only — no content.
 */
export const queueCountsSchema = z
  .object({
    name: z.string(),
    waiting: z.number().int().min(0),
    active: z.number().int().min(0),
    completed: z.number().int().min(0),
    failed: z.number().int().min(0),
    delayed: z.number().int().min(0),
  })
  .strict();
export type QueueCounts = z.infer<typeof queueCountsSchema>;

export const bucketUsageSchema = z
  .object({
    bucket: z.string(),
    objectCount: z.number().int().min(0),
    bytes: z.number().int().min(0),
  })
  .strict();
export type BucketUsage = z.infer<typeof bucketUsageSchema>;

export const adminOpsResponseSchema = z
  .object({
    queues: z.array(queueCountsSchema),
    storage: z.array(bucketUsageSchema),
    metrics: z
      .object({
        publishedMontages: z.number().int().min(0),
        activeUsers: z.number().int().min(0),
        expiredMontages: z.number().int().min(0),
        openReports: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type AdminOpsResponse = z.infer<typeof adminOpsResponseSchema>;
