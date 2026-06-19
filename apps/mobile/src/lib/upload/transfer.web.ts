/**
 * transfer.web — foreground PUT for web export (the screenshot/preview target).
 *
 * Web has no background-upload module, so we use XHR for real upload-progress
 * events (fetch can't report request-body progress in browsers). The blob is
 * fetched from the local `uri` (blob:/data:/http) then PUT to the presigned URL.
 * This is the spec's "foreground uploadAsync/fetch fallback on web".
 */
import type { PutFile, PutFileHandle } from './transfer';

export const putFile: PutFile = ({ url, uri, contentType, onProgress, signal }): PutFileHandle => {
  const xhr = new XMLHttpRequest();
  let aborted = false;

  const done = (async () => {
    // Materialize the local resource into a Blob for the request body.
    const blobRes = await fetch(uri);
    const blob = await blobRes.blob();

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

      if (signal) {
        if (signal.aborted) {
          xhr.abort();
        } else {
          signal.addEventListener('abort', () => xhr.abort(), { once: true });
        }
      }

      xhr.send(blob);
    });
  })();

  return {
    done,
    cancel: () => {
      if (!aborted) {
        aborted = true;
        try {
          xhr.abort();
        } catch {
          // ignore
        }
      }
    },
  };
};
