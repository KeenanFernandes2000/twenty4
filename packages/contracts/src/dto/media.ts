// Media DTOs (M4) — request/response contracts + the shared MIME allowlist and
// limits. Single source of truth; API + worker import these, never re-declare.
import { z } from "zod";
import { isValidTimezone } from "../dayWindow/index.ts";

// ── MIME allowlist (M4 §3) ────────────────────────────────────────────────────
// Photos: jpeg/png/heic; videos: mp4/quicktime(mov). Used both at init (declared
// content-type early-reject) and at /complete (actual HeadObject content-type).
export const PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif"] as const;
export const VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"] as const;

export type MediaType = "photo" | "video";

// Map a media type to its allowed content-types.
export function allowedMimesFor(mediaType: MediaType): readonly string[] {
  return mediaType === "photo" ? PHOTO_MIME_TYPES : VIDEO_MIME_TYPES;
}

// Is `contentType` allowed for `mediaType`? (Case-insensitive, params stripped.)
export function isAllowedMime(mediaType: MediaType, contentType: string): boolean {
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return (allowedMimesFor(mediaType) as readonly string[]).includes(base);
}

// ── Limits (M4 §3) ────────────────────────────────────────────────────────────
export const MAX_ITEMS_PER_DAY = 50;
export const MAX_BYTES_PER_ITEM = 200 * 1024 * 1024; // 200 MB
export const MAX_VIDEO_DURATION_MS = 60 * 1000; // 60s

// ── POST /media (init) ────────────────────────────────────────────────────────
export const mediaInitReqSchema = z.object({
  mediaType: z.enum(["photo", "video"]),
  contentType: z.string().min(1).max(128),
  byteSize: z.number().int().positive(),
  // IANA tz of the device (validated via Intl) — drives day_bucket resolution.
  deviceTimezone: z.string().min(1).refine(isValidTimezone, { message: "invalid IANA timezone" }),
  // When the device's media library says the item was captured (ISO 8601). Used as
  // the 2nd tier of the validation hierarchy (after EXIF). Optional.
  deviceCapturedAt: z.string().datetime({ offset: true }).optional(),
  // A client-declared original timestamp (ISO 8601). Lowest-trust hint; the worker
  // still prefers EXIF/media-library. Optional.
  declaredOriginalTimestamp: z.string().datetime({ offset: true }).optional(),
});
export type MediaInitReq = z.infer<typeof mediaInitReqSchema>;

export const mediaInitResSchema = z.object({
  id: z.string().uuid(),
  uploadUrl: z.string().url(),
  storageKey: z.string(),
});
export type MediaInitRes = z.infer<typeof mediaInitResSchema>;

// ── GET /media/today + the per-item wire shape ────────────────────────────────
export const mediaItemDtoSchema = z.object({
  id: z.string().uuid(),
  mediaType: z.enum(["photo", "video"]),
  dayBucket: z.string(), // YYYY-MM-DD
  validationStatus: z.enum(["pending", "valid", "invalid"]),
  processingStatus: z.enum(["uploaded", "validating", "valid", "invalid", "used", "deleted", "failed"]),
  originalTimestamp: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  uploadTimestamp: z.string(),
  // A short-TTL signed GET URL (host = public endpoint). Present for items that
  // have been uploaded; null for ones still in the `uploaded` (pre-PUT) state.
  downloadUrl: z.string().url().nullable(),
  // A short-TTL signed GET URL for the video poster frame (M7 §12). Null for
  // photos and for videos whose poster hasn't been extracted yet.
  thumbnailUrl: z.string().url().nullable(),
  metadataSummary: z.record(z.string(), z.unknown()),
});
export type MediaItemDTO = z.infer<typeof mediaItemDtoSchema>;

export const mediaTodayResSchema = z.object({
  dayBucket: z.string(),
  items: z.array(mediaItemDtoSchema),
});
export type MediaTodayRes = z.infer<typeof mediaTodayResSchema>;

// ── GET /media/:id/download-url ───────────────────────────────────────────────
export const downloadUrlResSchema = z.object({
  id: z.string().uuid(),
  downloadUrl: z.string().url(),
  expiresInSec: z.number().int(),
});
export type DownloadUrlRes = z.infer<typeof downloadUrlResSchema>;
