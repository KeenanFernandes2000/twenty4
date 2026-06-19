/**
 * metadata.native — derive upload metadata from native capture/pick results.
 *
 * DEVICE-ONLY (pulls expo-media-library for richer asset metadata). Web never
 * imports this — the gallery/camera entry points are native screens.
 *
 * The §6 validation hierarchy wants the BEST-resolved capture time:
 *   EXIF DateTimeOriginal  →  media-library asset.creationTime  →  file mtime
 * plus the device clock at upload (anti-tamper delta) and the device IANA tz
 * (drives the authoritative 4am day-window). We resolve content-type + size +
 * dimensions + duration here so the upload-init body is complete.
 */
import type { MediaType } from '@twenty4/contracts/enums';
import type { UploadMime } from '@twenty4/contracts/dto';

import type { UploadMetadata } from '../../stores/uploadStore';

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Map a (possibly null) mime/type into our contract's allowed upload mimes. */
export function resolveContentType(
  mimeType: string | null | undefined,
  mediaType: MediaType,
  fileName?: string | null,
): UploadMime {
  const m = (mimeType ?? '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return 'image/jpeg';
  if (m === 'image/png') return 'image/png';
  if (m === 'image/heic') return 'image/heic';
  if (m === 'image/heif') return 'image/heif';
  if (m === 'video/mp4') return 'video/mp4';
  if (m === 'video/quicktime' || m === 'video/mov') return 'video/quicktime';

  // Fall back on the filename extension.
  const ext = (fileName ?? '').toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'heic') return 'image/heic';
  if (ext === 'heif') return 'image/heif';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';

  // Last resort by media kind.
  return mediaType === 'video' ? 'video/mp4' : 'image/jpeg';
}

/**
 * Best-resolved capture time from an EXIF object, as an ISO string (or null).
 * EXIF DateTimeOriginal is `YYYY:MM:DD HH:MM:SS` (colons in the date) — normalize.
 */
export function exifCaptureTime(exif: Record<string, unknown> | null | undefined): string | null {
  if (!exif) return null;
  const raw =
    (exif.DateTimeOriginal as string | undefined) ??
    (exif.DateTimeDigitized as string | undefined) ??
    (exif.DateTime as string | undefined);
  if (!raw || typeof raw !== 'string') return null;
  // `2026:06:19 14:05:33` → `2026-06-19T14:05:33`
  const normalized = raw.replace(
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})$/,
    '$1-$2-$3T$4',
  );
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface RawAsset {
  uri: string;
  type?: 'image' | 'video' | 'livePhoto' | 'pairedVideo' | null;
  fileName?: string | null;
  fileSize?: number;
  mimeType?: string | null;
  width?: number;
  height?: number;
  duration?: number | null;
  exif?: Record<string, unknown> | null;
  assetId?: string | null;
}

/**
 * Build the upload metadata. `capturedInApp` distinguishes the trusted camera
 * path (auto-valid) from a library pick. For library picks we additionally try
 * `media-library.getAssetInfoAsync` to recover `creationTime` when EXIF is absent.
 */
export async function buildUploadMetadata(
  asset: RawAsset,
  opts: { capturedInApp: boolean },
): Promise<UploadMetadata> {
  const mediaType: MediaType = asset.type === 'video' ? 'video' : 'photo';
  const contentType = resolveContentType(asset.mimeType, mediaType, asset.fileName);

  // 1) EXIF capture time (best).
  let originalTimestamp = exifCaptureTime(asset.exif);

  // 2) media-library asset creationTime (when we have an assetId + no EXIF time).
  if (!originalTimestamp && asset.assetId) {
    try {
      const MediaLibrary = await import('expo-media-library');
      const info = await MediaLibrary.getAssetInfoAsync(asset.assetId);
      const exifTime = exifCaptureTime(info.exif as Record<string, unknown> | undefined);
      if (exifTime) {
        originalTimestamp = exifTime;
      } else if (typeof info.creationTime === 'number' && info.creationTime > 0) {
        originalTimestamp = new Date(info.creationTime).toISOString();
      }
    } catch {
      // media-library unavailable / limited permission — leave null; server
      // falls back to receive-time per §6.
    }
  }

  return {
    mediaType,
    contentType,
    sizeBytes: Math.max(1, Math.round(asset.fileSize ?? 0)),
    capturedInApp: opts.capturedInApp,
    originalTimestamp,
    deviceTimestamp: new Date().toISOString(),
    deviceTimezone: deviceTimezone(),
    durationMs: asset.duration != null ? Math.round(asset.duration) : null,
    width: asset.width && asset.width > 0 ? asset.width : undefined,
    height: asset.height && asset.height > 0 ? asset.height : undefined,
  };
}
