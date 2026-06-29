// Social DTOs (M8) — request/response contracts for the reaction + comment routes.
// Single source of truth; the API imports these, never re-declares them.
import { z } from "zod";

// ── Shared enums (M8) ─────────────────────────────────────────────────────────
// HAND-DUPLICATED with the pgEnums of the same name in db/schema/enums.ts
// (`reaction_type`, `comment_status`) — keep both lists in sync.
export const reactionTypeEnum = z.enum(["like", "laugh", "fire", "heart", "shocked"]);
export type ReactionType = z.infer<typeof reactionTypeEnum>;

export const commentStatusEnum = z.enum(["active", "deleted"]);
export type CommentStatus = z.infer<typeof commentStatusEnum>;

// ── Limits (M8 §11) ───────────────────────────────────────────────────────────
// Max comment length (chars). The server reads env COMMENT_MAX_LENGTH (configurable
// so CI can set a low cap) and that env field defaults to this constant; the route
// enforces the cap so it is NOT hardcoded into addCommentReqSchema.
export const COMMENT_MAX_LENGTH = 500;

// ── POST/DELETE /montages/:id/reactions ───────────────────────────────────────
export const setReactionReqSchema = z.object({
  type: reactionTypeEnum,
});
export type SetReactionReq = z.infer<typeof setReactionReqSchema>;

// Returned by POST + DELETE reactions — the live count + the viewer's own pick.
export const reactionSummarySchema = z.object({
  count: z.number().int(),
  viewerReaction: reactionTypeEnum.nullable(),
});
export type ReactionSummary = z.infer<typeof reactionSummarySchema>;

// ── POST /montages/:id/comments ───────────────────────────────────────────────
// `text` is non-empty here; the MAX length is enforced at the route from env so CI
// can set a low cap deterministically — do NOT hardcode the max in this schema.
export const addCommentReqSchema = z.object({
  text: z.string().trim().min(1),
});
export type AddCommentReq = z.infer<typeof addCommentReqSchema>;

// Comment wire shape (list + card preview). `author` mirrors how member identity
// is surfaced (display name + avatar). `canDelete` is true on the viewer's own.
export const commentDtoSchema = z.object({
  id: z.string().uuid(),
  montageId: z.string().uuid(),
  author: z.object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  text: z.string(),
  createdAt: z.string(), // ISO
  canDelete: z.boolean(),
});
export type CommentDTO = z.infer<typeof commentDtoSchema>;

// One keyset page of active, block-clean comments (GET /montages/:id/comments).
// `nextCursor` is null on the final page. Keyset tuple = (created_at ASC, id ASC).
export const commentsPageSchema = z.object({
  items: z.array(commentDtoSchema),
  nextCursor: z.string().nullable(),
});
export type CommentsPage = z.infer<typeof commentsPageSchema>;

// Returned by POST /montages/:id/comments — the new comment + the montage's live
// (block-filtered) active comment count so the card updates without a refetch.
export const addCommentResSchema = z.object({
  comment: commentDtoSchema,
  commentCount: z.number().int(),
});
export type AddCommentRes = z.infer<typeof addCommentResSchema>;
