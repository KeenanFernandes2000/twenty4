// upload/fileInfo — type face + misconfiguration tripwire for the statSize split.
//
// Metro resolves `./fileInfo.native.ts` on iOS/Android and `./fileInfo.web.ts`
// on web (platform extensions). TypeScript, which ignores the .native/.web
// split, resolves THIS module — so the `statSize` signature declared here is the
// contract both platform impls must satisfy. Mirrors transfer.ts / secureStore.ts.
//
// Like transfer.ts (and UNLIKE secureStore.ts, which re-exports its native face),
// the runtime body here is a TRIPWIRE: if Metro ever resolves this base module
// instead of a platform file, the call fails loudly. At bundle time Metro prefers
// fileInfo.web.ts / fileInfo.native.ts, so this throw is only ever hit on a
// misconfigured split.
//
// WHY platform-split: the native impl uses expo-file-system; importing it from
// the (shared, non-platform) uploadStore would pull expo-file-system's
// getInfoAsync/createUploadTask symbols into the WEB bundle. Splitting keeps the
// web bundle free of them — the store imports the type face, Metro substitutes
// fileInfo.web on web.

/**
 * Resolve the byte size of a local resource. NATIVE: a full `file://` URI.
 * WEB: a blob:/data:/http URL that `fetch().blob()` can read. Returns 0 when the
 * size can't be determined (caller treats 0/NaN as "could not read file size").
 */
export async function statSize(_uri: string): Promise<number> {
  throw new Error(
    'upload fileInfo: no platform implementation resolved (fileInfo.ts loaded instead of .native/.web)',
  );
}
