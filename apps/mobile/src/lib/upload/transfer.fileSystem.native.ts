/**
 * transfer.fileSystem.native — streaming, disk-backed foreground PUT for the
 * Expo-Go / dev-client fallback (when react-native-background-upload's native
 * module is absent).
 *
 * Replaces the memory-unsafe blob fallback (`fetch(uri).blob()` + XHR) which
 * loaded the ENTIRE file into the JS heap — fatal for large videos in Expo Go.
 * expo-file-system streams the file from disk natively, so heap usage stays flat
 * regardless of file size.
 *
 * SDK 56 NOTE: the root `expo-file-system` import does NOT export
 * `uploadAsync` / `createUploadTask`; the streaming upload API lives on the
 * LEGACY subpath. We import from there explicitly.
 *
 * DEVICE-ONLY: `.native` is selected by Metro on iOS/Android only; web uses
 * transfer.web.ts (the blob XHR foreground path). This module is never on a
 * web-reachable path.
 *
 * Satisfies the same `PutFile` contract as the background path: returns a
 * { done, cancel } handle, streams 0..1 progress, resolves on 2xx, rejects on
 * non-2xx / missing response, and supports cancellation via the returned
 * `cancel()` and/or an `AbortSignal`.
 */
import * as FileSystem from 'expo-file-system/legacy';

import type { PutFile, PutFileHandle } from './transfer';

export const putFileFileSystem: PutFile = ({
  url,
  uri,
  contentType,
  onProgress,
  signal,
}): PutFileHandle => {
  // NOTE: unlike the background-upload path, the legacy createUploadTask wants
  // the full file:// URI — do NOT strip the scheme here.
  const task = FileSystem.createUploadTask(
    url,
    uri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'Content-Type': contentType },
    },
    ({ totalBytesSent, totalBytesExpectedToSend }) => {
      // Guard divide-by-zero before the total is known.
      if (totalBytesExpectedToSend > 0) {
        onProgress?.(totalBytesSent / totalBytesExpectedToSend);
      }
    },
  );

  // Wire cancellation: both the returned cancel() and an optional AbortSignal
  // map to task.cancelAsync(). If the signal is already aborted, cancel
  // immediately — no pre-send dead window where an abort could be lost.
  if (signal) {
    if (signal.aborted) {
      void task.cancelAsync().catch(() => undefined);
    } else {
      signal.addEventListener(
        'abort',
        () => {
          void task.cancelAsync().catch(() => undefined);
        },
        { once: true },
      );
    }
  }

  const done = (async () => {
    const res = await task.uploadAsync();
    if (!res || res.status < 200 || res.status >= 300) {
      throw new Error(`Upload failed (${res ? res.status : 'no response'})`);
    }
    onProgress?.(1);
  })();

  return {
    done,
    cancel: () => {
      void task.cancelAsync().catch(() => undefined);
    },
  };
};
