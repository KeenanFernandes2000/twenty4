// Feed DTOs (M8) — the GET /feed card + page contracts and the opaque keyset
// cursor codec. Single source of truth; the API imports these, never re-declares.
import { z } from "zod";
import { commentDtoSchema, reactionTypeEnum } from "./social.ts";

// ── Page size (M8 §2) ─────────────────────────────────────────────────────────
// Cards per feed page. The route fetches N+1 to compute `nextCursor`.
export const FEED_PAGE_SIZE = 10;

// ── GET /feed card ────────────────────────────────────────────────────────────
// One published, unexpired, block-clean recap visible to the caller. `dayBucket`
// is display-only — the feed keys visibility on `expiry_at`, not the calendar day
// (M8 §11). Signed URLs carry a TTL ≤ remaining content lifetime. `canDelete` is
// true on the viewer's own montage, `canReport` on others'. `canReact` is false on
// the viewer's OWN montage (an owner only SEES the counts; the route 403s a self-
// reaction — M9 polish) and true on others'.
export const feedCardSchema = z.object({
  montageId: z.string().uuid(),
  author: z.object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  dayBucket: z.string(), // YYYY-MM-DD (display-only)
  expiryAt: z.string(), // ISO — drives the live expiry countdown
  durationMs: z.number().nullable(),
  videoUrl: z.string().url().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  reactionCount: z.number().int(),
  viewerReaction: reactionTypeEnum.nullable(),
  commentCount: z.number().int(),
  // ≤2 latest active, block-clean comments (M8 §11 preview depth).
  commentPreview: z.array(commentDtoSchema),
  canDelete: z.boolean(),
  canReport: z.boolean(),
  canReact: z.boolean(),
});
export type FeedCard = z.infer<typeof feedCardSchema>;

// One keyset page of feed cards. `nextCursor` is null on the final page.
export const feedPageSchema = z.object({
  items: z.array(feedCardSchema),
  nextCursor: z.string().nullable(),
});
export type FeedPage = z.infer<typeof feedPageSchema>;

// ── Cursor codec (M8 §5/§10) ──────────────────────────────────────────────────
// Opaque base64url(JSON) of the keyset sort tuple. The §10 learning: a malformed
// cursor MUST be catchable so the route maps it to 422 (VALIDATION), never a 500.
// So `decode*` THROWS a plain Error on ANY bad input (bad base64, bad JSON, missing
// or wrong-typed fields, bad date); the route wraps the decode in try/catch.

// The feed keyset tuple: (published_at DESC, id DESC).
const feedCursorSchema = z.object({
  publishedAt: z.string().datetime(),
  id: z.string().uuid(),
});

export function encodeFeedCursor(c: { publishedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeFeedCursor(s: string): { publishedAt: string; id: string } {
  try {
    return feedCursorSchema.parse(JSON.parse(Buffer.from(s, "base64url").toString("utf8")));
  } catch {
    throw new Error("malformed feed cursor");
  }
}

// The comments keyset tuple: (created_at ASC, id ASC).
const commentsCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});

export function encodeCommentsCursor(c: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCommentsCursor(s: string): { createdAt: string; id: string } {
  try {
    return commentsCursorSchema.parse(JSON.parse(Buffer.from(s, "base64url").toString("utf8")));
  } catch {
    throw new Error("malformed comments cursor");
  }
}
