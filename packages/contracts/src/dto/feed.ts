/**
 * Feed DTOs (§8 Feed & social): GET /feed?group={id}&cursor=.
 *
 * Chronological, today's published recaps from the caller's member groups, minus
 * blocked users (both directions). Paginated at 10 cards (§10).
 */
import { z } from 'zod';
import { reactionTypeSchema } from '../enums.js';
import { pageSchema, userSummarySchema } from './_common.js';

/** GET /feed query. */
export const feedQuerySchema = z
  .object({
    /** Optional: restrict to a single group; omit ⇒ all member groups. */
    group: z.string().uuid().optional(),
    cursor: z.string().optional(),
    /** Default & cap 10 per §10. */
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/** Aggregate reaction counts on a feed card (no per-user content). */
export const reactionSummarySchema = z
  .object({
    /** Counts keyed by reaction type. */
    counts: z.record(reactionTypeSchema, z.number().int().min(0)),
    total: z.number().int().min(0),
    /** The caller's own reaction, if any. */
    mine: reactionTypeSchema.nullable().optional(),
  })
  .strict();
export type ReactionSummary = z.infer<typeof reactionSummarySchema>;

/** A single feed card (a published montage visible to the caller). */
export const feedCardSchema = z
  .object({
    montageId: z.string().uuid(),
    author: userSummarySchema,
    thumbnailUrl: z.string().url().nullable().optional(),
    /** Signed playback URL (TTL ≤ remaining lifetime). */
    videoUrl: z.string().url().nullable().optional(),
    durationMs: z.number().int().nullable().optional(),
    publishedAt: z.string(),
    expiryAt: z.string(),
    /** Group(s) this card is surfaced through for the caller. */
    groupIds: z.array(z.string().uuid()),
    reactions: reactionSummarySchema,
    commentCount: z.number().int().min(0),
  })
  .strict();
export type FeedCard = z.infer<typeof feedCardSchema>;

export const feedResponseSchema = pageSchema(feedCardSchema);
export type FeedResponse = z.infer<typeof feedResponseSchema>;
