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
//   • asset.assetId is the media-library id (string | null) — null on web and from
//     the Android system photo picker; used to resolve the REAL gallery creation time.
//
// Verified against the installed expo-media-library 56.0.7 types: in SDK 56 the
// classic `getAssetInfoAsync` lives on the LEGACY entry point ('expo-media-library/
// legacy'); the package default export is the new class-based API (no getAssetInfo).
//   • requestPermissionsAsync(): Promise<PermissionResponse> (.granted)
//   • getAssetInfoAsync(asset: AssetRef): Promise<AssetInfo>, AssetRef = Asset | string
//   • AssetInfo.creationTime: number — epoch MILLISECONDS (0/absent ⇒ unknown).
// The '/legacy' web shim is import-safe (pure stub object), but we still guard every
// MediaLibrary call behind Platform.OS !== 'web' so the web bundle never touches a
// native module.
import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library/legacy';
import { isAllowedMime } from '@twenty4/contracts';
import type { UploadAsset } from '@/stores/uploadStore';

// Resolve an imported asset's REAL gallery creation time (native only). This is the
// signal that lets the server validate today's media from ANY source (incl. EXIF-
// stripped WhatsApp/social/screenshots) while still rejecting genuinely-old media —
// because it's the file's media-library creationTime, not a faked "now". Returns an
// ISO 8601 string for deviceCapturedAt, or undefined when unavailable (web, null
// assetId from the system photo picker, permission denied, or any lookup failure) —
// in which case we send NO timestamp and let the server fall back to EXIF / reject.
async function resolveDeviceCapturedAt(
  assetId: string | null | undefined,
): Promise<string | undefined> {
  if (Platform.OS === 'web' || !assetId) return undefined;
  try {
    // No-op if the picker's media permission already covers it; if not granted, skip.
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (!perm.granted) return undefined;
    const info = await MediaLibrary.getAssetInfoAsync(assetId);
    // creationTime is epoch milliseconds; 0/missing ⇒ treat as unavailable.
    if (typeof info.creationTime === 'number' && info.creationTime > 0) {
      return new Date(info.creationTime).toISOString();
    }
    return undefined;
  } catch {
    // Any failure (Expo Go limits, missing asset, web) → no timestamp.
    return undefined;
  }
}

async function toUploadAsset(asset: ImagePicker.ImagePickerAsset): Promise<UploadAsset> {
  const mediaType: UploadAsset['mediaType'] = asset.type === 'video' ? 'video' : 'photo';
  const contentType =
    asset.mimeType ?? (mediaType === 'video' ? 'video/mp4' : 'image/jpeg');
  // The file's true media-library creation time (native + known assetId only). When
  // unknown we send NEITHER deviceCapturedAt NOR declaredOriginalTimestamp: the server
  // then resolves from EXIF (camera-origin media still validates/rejects correctly) and
  // rejects truly-undated media — the safe direction. We never fake "now" for imports.
  const deviceCapturedAt = await resolveDeviceCapturedAt(asset.assetId);
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
    deviceCapturedAt,
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
  });

  if (result.canceled) return { assets: [], skipped: 0 };

  // Mapping is async (per-asset media-library creation-time lookup on native).
  const mapped = await Promise.all(result.assets.map(toUploadAsset));
  // Pre-filter against the server's MIME allowlist so off-allowlist types (webp/gif/
  // 3gpp/…) are dropped here instead of wasting an init→PUT→complete 415 round-trip.
  const assets = mapped.filter((a) => isAllowedMime(a.mediaType, a.contentType));
  return { assets, skipped: mapped.length - assets.length };
}
