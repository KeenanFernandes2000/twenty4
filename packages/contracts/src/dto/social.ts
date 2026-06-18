/**
 * Social DTOs (§8 Feed & social): reactions (upsert/delete) + comments (list/add/delete).
 */
import { z } from 'zod';
import { reactionTypeSchema } from '../enums.js';
import { cursorPaginationSchema, pageSchema, userSummarySchema } from './_common.js';

/** POST /montages/{id}/reactions — upsert (one per user per montage, §5). */
export const upsertReactionRequestSchema = z
  .object({ type: reactionTypeSchema })
  .strict();
export type UpsertReactionRequest = z.infer<typeof upsertReactionRequestSchema>;

export const reactionResponseSchema = z
  .object({
    montageId: z.string().uuid(),
    type: reactionTypeSchema,
    createdAt: z.string(),
  })
  .strict();
export type ReactionResponse = z.infer<typeof reactionResponseSchema>;

/** POST /montages/{id}/comments. */
export const createCommentRequestSchema = z
  .object({ text: z.string().min(1).max(500) })
  .strict();
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;

/** A comment as returned (lives & dies with its montage, §6). */
export const commentResponseSchema = z
  .object({
    id: z.string().uuid(),
    montageId: z.string().uuid(),
    author: userSummarySchema,
    text: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type CommentResponse = z.infer<typeof commentResponseSchema>;

/** GET /montages/{id}/comments — cursor-paginated. */
export const commentsQuerySchema = cursorPaginationSchema;
export type CommentsQuery = z.infer<typeof commentsQuerySchema>;

export const commentsResponseSchema = pageSchema(commentResponseSchema);
export type CommentsResponse = z.infer<typeof commentsResponseSchema>;
