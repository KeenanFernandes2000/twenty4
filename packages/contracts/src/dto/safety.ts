/**
 * Safety DTOs (§8 Safety): POST /reports · POST /blocks · DELETE /blocks/{userId}
 * · GET /users/me/blocks.
 */
import { z } from 'zod';
import { reportReasonSchema, reportTargetTypeSchema } from '../enums.js';
import { userSummarySchema } from './_common.js';

/** POST /reports. */
export const createReportRequestSchema = z
  .object({
    targetType: reportTargetTypeSchema,
    targetId: z.string().uuid(),
    reason: reportReasonSchema,
    /** Optional free-text detail (stored on the report, not in analytics). */
    detail: z.string().max(1000).optional(),
  })
  .strict();
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;

export const reportResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(['open', 'under_review', 'actioned', 'dismissed']),
    createdAt: z.string(),
  })
  .strict();
export type ReportResponse = z.infer<typeof reportResponseSchema>;

/** POST /blocks. */
export const createBlockRequestSchema = z
  .object({ userId: z.string().uuid() })
  .strict();
export type CreateBlockRequest = z.infer<typeof createBlockRequestSchema>;

/** GET /users/me/blocks. */
export const blockListResponseSchema = z
  .object({ items: z.array(userSummarySchema) })
  .strict();
export type BlockListResponse = z.infer<typeof blockListResponseSchema>;
