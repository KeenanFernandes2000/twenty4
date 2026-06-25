// upload/fileInfo.web — byte size of a blob:/data:/http URL (web).
//
// Metro picks this over fileInfo.native.ts on web (platform extension). Browser
// Blobs are storage-backed, so reading one to get its size is cheap and safe —
// and it keeps expo-file-system OUT of the web bundle (the native face uses it).
export async function statSize(uri: string): Promise<number> {
  const blob = await (await fetch(uri)).blob();
  return blob.size;
}
