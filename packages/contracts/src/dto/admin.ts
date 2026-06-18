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

/** Action a report (resolve + optional content removal). */
export const adminResolveReportRequestSchema = z
  .object({
    resolution: z.enum(['actioned', 'dismissed']),
    removeContent: z.boolean().default(false),
    note: z.string().max(500).optional(),
  })
  .strict();
export type AdminResolveReportRequest = z.infer<typeof adminResolveReportRequestSchema>;

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
