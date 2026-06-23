/**
 * transfer.foreground — shared foreground PUT used by:
 *   - transfer.web.ts            (web has no background-upload module)
 *   - transfer.native.ts fallback (Expo Go / dev clients where the
 *     react-native-background-upload native module is absent)
 *
 * Uses XMLHttpRequest for real upload-progress events: `xhr.upload.onprogress`
 * fires request-body progress, which `fetch` cannot report in browsers OR in
 * React Native. The blob is materialized from the local `uri`
 * (blob:/data:/http on web, file:// in RN) then PUT to the presigned URL.
 *
 * Satisfies the same `PutFile` contract as the background path: returns a
 * { done, cancel } handle, streams 0..1 progress, resolves on 2xx, rejects on
 * non-2xx / network error, and supports cancellation via `xhr.abort()` — driven
 * by either an `AbortSignal` (web) or the returned `cancel()` (native).
 */
import type { PutFile, PutFileHandle } from './transfer';

export const putFileForeground: PutFile = ({
  url,
  uri,
  contentType,
  onProgress,
  signal,
}): PutFileHandle => {
  const xhr = new XMLHttpRequest();
  let aborted = false;

  /**
   * Mark aborted + abort the xhr. xhr.abort() is a no-op while the request is
   * still UNSENT (i.e. during blob materialization, before xhr.send()), so we
   * also track `aborted` and bail before send() — see the guard below. This
   * fixes the bug where a cancel()/signal abort fired during the `await
   * fetch(uri).blob()` phase was silently lost and send() fired anyway.
   */
  const abort = () => {
    if (aborted) return;
    aborted = true;
    try {
      xhr.abort();
    } catch {
      // ignore
    }
  };

  // Wire the AbortSignal up-front so an abort during blob materialization is
  // captured (sets `aborted`) and short-circuits the send below.
  if (signal) {
    if (signal.aborted) {
      aborted = true;
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
  }

  const done = (async () => {
    // Materialize the local resource into a Blob for the request body.
    const blobRes = await fetch(uri);
    const blob = await blobRes.blob();

    // If cancelled/aborted before or during materialization, never call send();
    // xhr.abort() on an UNSENT xhr is a no-op, so reject explicitly instead.
    if (aborted) {
      throw new Error('Upload cancelled');
    }

    await new Promise<void>((resolve, reject) => {
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('Content-Type', contentType);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.(1);
          resolve();
        } else {
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onabort = () => reject(new Error('Upload cancelled'));

      xhr.send(blob);
    });
  })();

  return {
    done,
    cancel: abort,
  };
};
