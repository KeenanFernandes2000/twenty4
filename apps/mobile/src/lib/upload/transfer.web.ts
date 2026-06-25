// upload/transfer.web — WEB platform implementation.
//
// Metro picks this over transfer.native.ts on web (platform extension). Web uses
// the foreground XHR uploader: browser Blobs are storage-backed, so
// fetch().blob() is safe here. This keeps the native-only fileSystem path (and
// thus expo-file-system) OUT of the web bundle entirely.
export { putFile } from './transfer.foreground';
