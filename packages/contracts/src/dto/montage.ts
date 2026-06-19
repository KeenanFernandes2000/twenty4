/**
 * Montage DTOs (§8 Montage): generate · status poll · regenerate · publish ·
 * replace · download-url · delete.
 */
import { z } from 'zod';
import { montageStatusSchema, themeSchema } from '../enums.js';

/** POST /montages — generate (theme, music, selected media). */
export const generateMontageRequestSchema = z
  .object({
    /** Selected daily_media_item ids to include (must be valid & today's). */
    mediaIds: z.array(z.string().uuid()).min(1).max(50),
    theme: themeSchema,
    musicId: z.string().min(1),
  })
  .strict();
export type GenerateMontageRequest = z.infer<typeof generateMontageRequestSchema>;

/** POST /montages/{id}/regenerate — re-run intelligence (optionally new theme/music). */
export const regenerateMontageRequestSchema = z
  .object({
    mediaIds: z.array(z.string().uuid()).min(1).max(50).optional(),
    theme: themeSchema.optional(),
    musicId: z.string().min(1).optional(),
  })
  .strict();
export type RegenerateMontageRequest = z.infer<typeof regenerateMontageRequestSchema>;

/** GET /montages/{id} — status poll (§7.3) + the montage view. */
export const montageResponseSchema = z
  .object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    status: montageStatusSchema,
    theme: themeSchema.nullable().optional(),
    musicId: z.string().nullable().optional(),
    durationMs: z.number().int().nullable().optional(),
    /** Signed playback URL; null until draft_ready / when expired (→ 404 on fetch). */
    videoUrl: z.string().url().nullable().optional(),
    thumbnailUrl: z.string().url().nullable().optional(),
    publishedAt: z.string().nullable().optional(),
    expiryAt: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .strict();
export type MontageResponse = z.infer<typeof montageResponseSchema>;

/** 202 body returned by generate/regenerate (§7.3). */
export const montageGeneratingResponseSchema = z
  .object({
    montageId: z.string().uuid(),
    status: montageStatusSchema,
  })
  .strict();
export type MontageGeneratingResponse = z.infer<typeof montageGeneratingResponseSchema>;

/**
 * POST /montages/{id}/publish — publish to selected groups (Q1: one render →
 * many groups). Idempotency-Key header required (§8 cross-cutting).
 */
export const publishMontageRequestSchema = z
  .object({
    groupIds: z.array(z.string().uuid()).min(1),
  })
  .strict();
export type PublishMontageRequest = z.infer<typeof publishMontageRequestSchema>;

/**
 * POST /montages/{id}/replace (Q2) — on successful publish of the replacement,
 * the prior montage + its reactions/comments are hard-deleted. Idempotency-Key
 * required. Body mirrors publish: which groups the replacement is visible to.
 */
export const replaceMontageRequestSchema = z
  .object({
    /** The newly-generated montage id that replaces the current one. */
    replacementMontageId: z.string().uuid(),
    groupIds: z.array(z.string().uuid()).min(1),
  })
  .strict();
export type ReplaceMontageRequest = z.infer<typeof replaceMontageRequestSchema>;

/** GET /montages/{id}/download-url — OWNER ONLY (Q7). Signed GET. */
export const downloadUrlResponseSchema = z
  .object({
    downloadUrl: z.string().url(),
    expiresIn: z.number().int(),
  })
  .strict();
export type DownloadUrlResponse = z.infer<typeof downloadUrlResponseSchema>;

/**
 * GET /montages/options — available themes + music tracks for the review screens
 * (2.6 theme picker / 2.7 music picker). Themes come from the enum; music tracks
 * (id/label/bpm) come from the bundled music registry. The client renders these
 * choices and sends a `theme` + `musicId` back on generate/regenerate.
 */
export const musicTrackOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    bpm: z.number().int().positive(),
    /** True = synthesized placeholder (§13 music source TBD); UI may hint this. */
    synthesized: z.boolean().optional(),
  })
  .strict();
export type MusicTrackOption = z.infer<typeof musicTrackOptionSchema>;

export const montageOptionsResponseSchema = z
  .object({
    /** Selectable theme names (includes `Random`). */
    themes: z.array(themeSchema),
    /** Default theme when the client doesn't pick one. */
    defaultTheme: themeSchema,
    music: z.array(musicTrackOptionSchema),
    /** Default music id when the client doesn't pick one. */
    defaultMusicId: z.string().min(1),
  })
  .strict();
export type MontageOptionsResponse = z.infer<typeof montageOptionsResponseSchema>;
