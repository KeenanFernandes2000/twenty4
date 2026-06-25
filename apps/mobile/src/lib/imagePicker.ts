// imagePicker — a thin, platform-agnostic wrapper over expo-image-picker that
// produces the upload store's UploadAsset[] shape. expo-image-picker handles web
// itself (it renders an <input type=file> on web), so the same call works in the
// headless-Chromium e2e and on Android.
//
// Verified against the installed expo-image-picker 56.0.18 types:
//   • launchImageLibraryAsync({ mediaTypes, allowsMultipleSelection, quality })
//   • mediaTypes is `MediaType | MediaType[] | MediaTypeOptions` where
//     MediaType = 'images' | 'videos' | 'livePhotos' → we pass ['images','videos'].
//   • result is a discriminated union: { canceled: true, assets: null } |
//     { canceled: false, assets: ImagePickerAsset[] } → guard on `canceled`.
//   • asset.type is 'image'|'video'|'livePhoto'|'pairedVideo'|null; duration is in ms.
import * as ImagePicker from 'expo-image-picker';
import { isAllowedMime } from '@twenty4/contracts';
import type { UploadAsset } from '@/stores/uploadStore';

function toUploadAsset(asset: ImagePicker.ImagePickerAsset): UploadAsset {
  const mediaType: UploadAsset['mediaType'] = asset.type === 'video' ? 'video' : 'photo';
  const contentType =
    asset.mimeType ?? (mediaType === 'video' ? 'video/mp4' : 'image/jpeg');
  return {
    uri: asset.uri,
    mediaType,
    contentType,
    // fileSize is optional on the asset; when absent the store resolves it via statSize.
    byteSize: asset.fileSize,
    fileName: asset.fileName ?? undefined,
    width: asset.width || undefined,
    height: asset.height || undefined,
    // duration is milliseconds (number | null); round defensively.
    durationMs: asset.duration != null ? Math.round(asset.duration) : undefined,
    // Imports declare their original timestamp as "now" (lowest-trust tier): the
    // server's validation worker resolves EXIF → deviceCapturedAt → this declared
    // value → else REJECT, so a no-EXIF gallery photo can validate as today. The
    // worker still rejects any asset whose EXIF proves it's older (anti-backfill).
    // We deliberately do NOT set deviceCapturedAt for imports — that tier implies
    // device-library provenance; keep imports at the declared tier.
    declaredOriginalTimestamp: new Date().toISOString(),
  };
}

/** Result of an import: supported assets to enqueue + count of skipped (off-allowlist). */
export interface ImportResult {
  assets: UploadAsset[];
  skipped: number;
}

/**
 * Prompt for media-library permission, then launch the library picker (multi-select,
 * photos + videos). Returns supported assets mapped to UploadAsset[] PLUS a count of
 * assets skipped for being off the server's MIME allowlist (image/webp, image/gif,
 * video/3gpp, …) — filtered client-side so they never round-trip to a server 415.
 * Returns { assets: [], skipped: 0 } on cancel OR permission denial — the caller can't
 * tell those apart here (toast a neutral "no media added" when empty).
 */
export async function pickFromLibrary(): Promise<ImportResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { assets: [], skipped: 0 };

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    quality: 1,
    exif: true, // cheap; lets the server (and future client) read true capture EXIF.
  });

  if (result.canceled) return { assets: [], skipped: 0 };

  const mapped = result.assets.map(toUploadAsset);
  // Pre-filter against the server's MIME allowlist so off-allowlist types (webp/gif/
  // 3gpp/…) are dropped here instead of wasting an init→PUT→complete 415 round-trip.
  const assets = mapped.filter((a) => isAllowedMime(a.mediaType, a.contentType));
  return { assets, skipped: mapped.length - assets.length };
}
