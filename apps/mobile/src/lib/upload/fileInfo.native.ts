// upload/fileInfo.native — byte size of a local file:// URI (native).
//
// Metro picks this over fileInfo.web.ts on iOS/Android. Uses expo-file-system's
// LEGACY getInfoAsync (same `expo-file-system/legacy` subpath as the streaming
// uploader in transfer.fileSystem.native.ts) with `{ size: true }` so the size
// field is computed.
//
// VERIFIED against the installed package (expo-file-system@56.0.8):
//   - getInfoAsync(fileUri, options?: { md5?: boolean }): Promise<FileInfo>
//     NOTE: the legacy 56.x InfoOptions has NO `size` flag — size is ALWAYS
//     computed and returned on the `exists: true` branch (older RNs gated it
//     behind `{ size: true }`; that option was removed). So we just call it.
//   - FileInfo is a discriminated union: { exists: true; uri; size: number; ... }
//     when the file exists, { exists: false; uri; ... } when it doesn't.
//   So we narrow on `exists` and read `size` only on the present branch.
//
// The full `file://` URI is passed through unchanged (scheme kept), matching the
// streaming uploader's contract.

import { getInfoAsync } from 'expo-file-system/legacy';

export async function statSize(uri: string): Promise<number> {
  const info = await getInfoAsync(uri);
  // `size` exists only on the `exists: true` branch of the FileInfo union.
  return info.exists ? info.size : 0;
}
