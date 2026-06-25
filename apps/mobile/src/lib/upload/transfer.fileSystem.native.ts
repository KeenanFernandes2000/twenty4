// upload/transfer.fileSystem.native — disk-backed streaming PUT (Expo Go path).
//
// The PutFile impl for native when no background-upload native module exists
// (always, in Expo Go). Uses expo-file-system's LEGACY uploader, which streams
// the file from disk — it does NOT load the bytes into the JS heap, so a 30MB
// video uploads without an OOM. (The web path's fetch().blob() would OOM here;
// that's why native must use this instead.)
//
// VERIFIED against the installed package (expo-file-system@56.0.8):
//   - API lives on the `expo-file-system/legacy` subpath (NOT the package root).
//   - createUploadTask(url, fileUri, options?, callback?): UploadTask
//   - UploadTask#uploadAsync(): Promise<FileSystemUploadResult | undefined | null>
//       * resolves to undefined/null when the task was CANCELLED (it does NOT
//         reject on cancel) — we map that to UploadAbortedError.
//       * FileSystemUploadResult = { status: number; headers; body; mimeType }
//   - UploadTask#cancelAsync(): Promise<void>  (from FileSystemCancellableNetworkTask)
//   - FileSystemUploadType.BINARY_CONTENT  (file as the raw request body)
//   - progress callback data: { totalBytesSent, totalBytesExpectedToSend }
//   - httpMethod accepts 'PUT' (FileSystemAcceptedUploadHttpMethod = POST|PUT|PATCH)
//
// The full `file://` URI is passed THROUGH unchanged — the legacy uploader wants
// the scheme; stripping it breaks the read.

import {
  createUploadTask,
  FileSystemUploadType,
  type UploadProgressData,
} from 'expo-file-system/legacy';

import { UploadAbortedError, type PutFile } from './types';

export const putFile: PutFile = ({ uploadUrl, uri, contentType, onProgress }) => {
  let aborted = false;

  // createUploadTask is synchronous — the task (and thus cancel()) is live the
  // instant putFile() returns.
  const task = createUploadTask(
    uploadUrl,
    uri, // keep the file:// scheme
    {
      httpMethod: 'PUT',
      uploadType: FileSystemUploadType.BINARY_CONTENT,
      // Always declare the content type — S3 presign + server HeadObject gate.
      headers: { 'Content-Type': contentType },
    },
    (data: UploadProgressData) => {
      if (onProgress && data.totalBytesExpectedToSend > 0) {
        onProgress(data.totalBytesSent / data.totalBytesExpectedToSend);
      }
    },
  );

  const done = task
    .uploadAsync()
    .then((res) => {
      // A cancelled task resolves to null/undefined (it does not reject).
      if (!res) {
        throw new UploadAbortedError();
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`upload PUT failed: HTTP ${res.status}`);
      }
      onProgress?.(1);
    })
    .catch((err: unknown) => {
      // If we initiated a cancel, normalize any thrown error to the abort error
      // so callers see a single, distinguishable cancellation signal.
      if (aborted) {
        throw new UploadAbortedError();
      }
      throw err;
    });

  const cancel = () => {
    if (aborted) return; // idempotent
    aborted = true;
    // cancelAsync is async/best-effort; we don't await it (cancel() is sync).
    // The library logs (not throws) if the task already finished, so swallow.
    void Promise.resolve(task.cancelAsync()).catch(() => {
      // ignore — task may have already settled
    });
  };

  return { done, cancel };
};
