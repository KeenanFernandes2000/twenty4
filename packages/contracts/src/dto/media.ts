/**
 * Media bucket DTOs (§8 Media bucket): POST /media/upload-url · POST /media ·
 * GET /media/today · DELETE /media/{id}.
 */
import { z } from 'zod';
import {
  mediaProcessingStatusSchema,
  mediaTypeSchema,
  validationStatusSchema,
} from '../enums.js';

/** Upload limits (§10): photos JPG/PNG/HEIC, videos MP4/MOV, ≤200MB, video ≤60s. */
export const UPLOAD_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
] as const;
export const uploadMimeSchema = z.enum(UPLOAD_MIME_TYPES);
export type UploadMime = z.infer<typeof uploadMimeSchema>;

export const MAX_ITEM_BYTES = 200 * 1024 * 1024; // 200MB (§10)
export const MAX_VIDEO_MS = 60_000; // 60s (§10)
export const MAX_DAILY_ITEMS = 50; // (§10)

/** POST /media/upload-url — request a signed PUT URL. */
export const uploadUrlRequestSchema = z
  .object({
    mediaType: mediaTypeSchema,
    contentType: uploadMimeSchema,
    sizeBytes: z.number().int().min(1).max(MAX_ITEM_BYTES),
  })
  .strict();
export type UploadUrlRequest = z.infer<typeof uploadUrlRequestSchema>;

export const uploadUrlResponseSchema = z
  .object({
    /** Signed PUT URL (TTL bounded by content lifetime, §11). */
    uploadUrl: z.string().url(),
    /** Opaque storage key to send back in POST /media. */
    storageKey: z.string(),
    /** Seconds until the signed URL expires. */
    expiresIn: z.number().int(),
  })
  .strict();
export type UploadUrlResponse = z.infer<typeof uploadUrlResponseSchema>;

/**
 * POST /media — create the record after the client PUTs to S3. Carries client
 * metadata used by the §6 validation hierarchy (resolved timestamp + device time
 * for anti-tamper). Server re-derives `day_bucket` authoritatively.
 */
export const createMediaRequestSchema = z
  .object({
    storageKey: z.string(),
    mediaType: mediaTypeSchema,
    contentType: uploadMimeSchema,
    sizeBytes: z.number().int().min(1).max(MAX_ITEM_BYTES),
    /** True if captured in-app (auto-valid, §6). */
    capturedInApp: z.boolean().default(false),
    /** Best-resolved capture time (EXIF→media-lib→file), ISO; null if none. */
    originalTimestamp: z.string().datetime().nullable().optional(),
    /** Device clock at upload (anti-tamper delta vs server time, §6). */
    deviceTimestamp: z.string().datetime().optional(),
    /** Device IANA tz at capture/upload — drives the 4am day-window (§6 Q3). */
    deviceTimezone: z.string().optional(),
    durationMs: z.number().int().min(0).max(MAX_VIDEO_MS).nullable().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();
export type CreateMediaRequest = z.infer<typeof createMediaRequestSchema>;

/**
 * POST /media (upload init) — the client requests an upload slot BEFORE PUTting
 * bytes. It supplies the media kind, content-type, size, and capture metadata used
 * by the §6 validation hierarchy + the 4am day-window. The server resolves
 * `day_bucket` AUTHORITATIVELY from `deviceTimezone` (never a client-sent bucket),
 * inserts a `pending` row, and returns a presigned PUT + the row id + the resolved
 * bucket. This replaces the older upload-url→create two-call dance (kept below for
 * back-compat) with a single init that also persists the metadata server-side.
 */
export const mediaInitRequestSchema = z
  .object({
    mediaType: mediaTypeSchema,
    contentType: uploadMimeSchema,
    sizeBytes: z.number().int().min(1).max(MAX_ITEM_BYTES),
    /** True if captured in-app (the trusted camera path → auto-valid, §6). */
    capturedInApp: z.boolean().default(false),
    /** Best-resolved client capture time (EXIF→media-lib→file), ISO; null if none. */
    originalTimestamp: z.string().datetime({ offset: true }).nullable().optional(),
    /** Device clock at upload (anti-tamper delta vs server receive time, §6). */
    deviceTimestamp: z.string().datetime({ offset: true }).optional(),
    /** Device IANA tz at capture/upload — drives the authoritative day-window. */
    deviceTimezone: z.string().min(1).optional(),
    durationMs: z.number().int().min(0).max(MAX_VIDEO_MS).nullable().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();
export type MediaInitRequest = z.infer<typeof mediaInitRequestSchema>;

/** POST /media response — the upload slot. */
export const mediaInitResponseSchema = z
  .object({
    /** The created `daily_media_item` id (poll/complete by this). */
    id: z.string().uuid(),
    /** Presigned PUT URL (raw bucket; TTL clamped to remaining lifetime). */
    uploadUrl: z.string().url(),
    /** Server-minted storage key (client echoes nothing; informational). */
    storageKey: z.string(),
    /** Server-resolved 4am day bucket (YYYY-MM-DD) — authoritative. */
    dayBucket: z.string(),
    /** Seconds until the upload URL expires. */
    expiresIn: z.number().int().positive(),
  })
  .strict();
export type MediaInitResponse = z.infer<typeof mediaInitResponseSchema>;

/** GET /media/:id/download-url (owner-only) response. */
export const mediaDownloadUrlResponseSchema = z
  .object({
    url: z.string().url(),
    expiresIn: z.number().int().positive(),
  })
  .strict();
export type MediaDownloadUrlResponse = z.infer<typeof mediaDownloadUrlResponseSchema>;

/** A media item as returned to its owner. */
export const mediaItemResponseSchema = z
  .object({
    id: z.string().uuid(),
    mediaType: mediaTypeSchema,
    dayBucket: z.string(), // YYYY-MM-DD
    validationStatus: validationStatusSchema,
    processingStatus: mediaProcessingStatusSchema,
    /** True if captured in-app (trusted path). */
    capturedInApp: z.boolean().optional(),
    /** Anti-tamper: device clock vs server time delta exceeded the threshold (§6). */
    deviceTimeSuspicious: z.boolean().optional(),
    durationMs: z.number().int().nullable().optional(),
    width: z.number().int().nullable().optional(),
    height: z.number().int().nullable().optional(),
    /** Signed GET URL for preview (TTL ≤ remaining lifetime). */
    previewUrl: z.string().url().nullable().optional(),
    createdAt: z.string(),
  })
  .strict();
export type MediaItemResponse = z.infer<typeof mediaItemResponseSchema>;

/** GET /media/today. */
export const todayMediaResponseSchema = z
  .object({
    dayBucket: z.string(),
    items: z.array(mediaItemResponseSchema),
    /** Convenience: count of valid items eligible for a montage. */
    validCount: z.number().int().min(0),
  })
  .strict();
export type TodayMediaResponse = z.infer<typeof todayMediaResponseSchema>;
