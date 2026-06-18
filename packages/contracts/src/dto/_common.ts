/**
 * Shared DTO primitives (§8). Reused across resource schemas.
 */
import { z } from 'zod';

/** A UUID path/body id. */
export const uuidSchema = z.string().uuid();

/** Cursor-based pagination request (feed/comments). */
export const cursorPaginationSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type CursorPagination = z.infer<typeof cursorPaginationSchema>;

/** Generic cursor page envelope. */
export const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item),
      /** Opaque cursor for the next page; null/absent ⇒ end. */
      nextCursor: z.string().nullable().optional(),
    })
    .strict();

/** A public user summary embedded in feed/comments/members (non-sensitive). */
export const userSummarySchema = z
  .object({
    id: uuidSchema,
    displayName: z.string(),
    username: z.string(),
    profilePhotoUrl: z.string().url().nullable().optional(),
  })
  .strict();
export type UserSummary = z.infer<typeof userSummarySchema>;
