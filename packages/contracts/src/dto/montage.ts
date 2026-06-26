// Montage DTOs (M7) — request/response contracts for the montage routes.
// Single source of truth; the API + worker import these, never re-declare them.
import { z } from "zod";
import { montageStatusEnum, themeEnum } from "./montageEnums.ts";

// Surface the shared enums through the barrel via this module.
export * from "./montageEnums.ts";

// ── Limits (M7 §5) ────────────────────────────────────────────────────────────
// The N floor of valid items required to generate/regenerate a montage. The server
// reads env MONTAGE_MIN_MEDIA (configurable) and that env field defaults to this
// constant; the mobile readiness gate imports it so it never contradicts the server.
export const MONTAGE_MIN_MEDIA = 3;

// ── POST /montages (generate today's montage) ─────────────────────────────────
// All fields optional — the server applies defaults (today's valid media, a
// default theme, a default track) when omitted.
export const createMontageReqSchema = z.object({
  mediaIds: z.array(z.string().uuid()).optional(),
  theme: themeEnum.optional(),
  musicId: z.string().optional(),
});
export type CreateMontageReq = z.infer<typeof createMontageReqSchema>;

// 202 body from POST /montages (and regenerate).
export const createMontageResSchema = z.object({
  montageId: z.string().uuid(),
  status: montageStatusEnum,
});
export type CreateMontageRes = z.infer<typeof createMontageResSchema>;

// ── GET /montages/:id (the client poll target) ────────────────────────────────
export const montageDtoSchema = z.object({
  id: z.string().uuid(),
  status: montageStatusEnum,
  dayBucket: z.string(), // YYYY-MM-DD
  theme: themeEnum,
  musicId: z.string(),
  durationMs: z.number().nullable(),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
  expiryAt: z.string().nullable(),
  // Signed GET URLs — present once `draft_ready`, null before.
  previewUrl: z.string().url().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  sourceMediaIds: z.array(z.string().uuid()),
  // The retryable error message surfaced to the client when status=failed.
  error: z.string().nullable(),
});
export type MontageDTO = z.infer<typeof montageDtoSchema>;

// ── POST /montages/:id/regenerate ─────────────────────────────────────────────
// `mediaIds` optional → remove-media-and-regenerate passes the trimmed subset.
// `theme`/`musicId` optional → the review-screen picker re-renders with a new look;
// omitted fields keep the row's current value.
export const regenerateMontageReqSchema = z.object({
  mediaIds: z.array(z.string().uuid()).optional(),
  theme: themeEnum.optional(),
  musicId: z.string().optional(),
});
export type RegenerateMontageReq = z.infer<typeof regenerateMontageReqSchema>;

// ── POST /montages/:id/publish ────────────────────────────────────────────────
export const publishMontageReqSchema = z.object({
  groupIds: z.array(z.string().uuid()).min(1),
});
export type PublishMontageReq = z.infer<typeof publishMontageReqSchema>;

export const publishMontageResSchema = z.object({
  id: z.string().uuid(),
  status: montageStatusEnum,
  publishedAt: z.string(),
  expiryAt: z.string(),
  groupIds: z.array(z.string().uuid()),
});
export type PublishMontageRes = z.infer<typeof publishMontageResSchema>;

// ── GET /montages/options (the theme + music picker feed) ─────────────────────
export const montageOptionsResSchema = z.object({
  themes: z.array(themeEnum),
  tracks: z.array(
    z
      .object({
        id: z.string(),
        title: z.string(),
        durationMs: z.number(),
        bpm: z.number(),
      })
      .strict(),
  ),
});
export type MontageOptionsRes = z.infer<typeof montageOptionsResSchema>;
