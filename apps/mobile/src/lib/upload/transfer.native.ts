/**
 * transfer.native — true background / resumable PUT via
 * react-native-background-upload (iOS NSURLSession background + Android
 * foreground-service upload). This is the spec's hard requirement over
 * expo-file-system background sessions (known large-file failures).
 *
 * DEVICE-ONLY: this module pulls a native module and is selected by Metro only
 * on iOS/Android (web gets transfer.web.ts). It is never on a web-reachable path.
 *
 * We start a `raw` PUT to the presigned URL, subscribe to progress/completed/
 * error for our `customUploadId`, and resolve/reject accordingly. `cancel` maps
 * to the native cancelUpload.
 */
import Upload from 'react-native-background-upload';

import type { PutFile, PutFileHandle } from './transfer';

export const putFile: PutFile = ({
  url,
  uri,
  contentType,
  uploadId,
  onProgress,
}): PutFileHandle => {
  let cancelled = false;

  const done = (async () => {
    // background-upload wants a bare path (strip the file:// scheme on iOS).
    const path = uri.replace(/^file:\/\//, '');

    const subs: { remove: () => void }[] = [];
    const cleanup = () => subs.forEach((s) => s.remove());

    try {
      const id = await Upload.startUpload({
        url,
        path,
        method: 'PUT',
        type: 'raw',
        customUploadId: uploadId,
        headers: { 'Content-Type': contentType },
        notification: {
          enabled: true,
          autoClear: true,
          onProgressTitle: 'twenty4',
          onProgressMessage: 'Uploading today’s moment…',
          onCompleteTitle: 'twenty4',
          onCompleteMessage: 'Upload complete',
          onErrorTitle: 'twenty4',
          onErrorMessage: 'Upload failed',
        },
      });

      await new Promise<void>((resolve, reject) => {
        subs.push(
          Upload.addListener('progress', id, (data) => {
            if (!cancelled) onProgress?.((data.progress ?? 0) / 100);
          }),
        );
        subs.push(
          Upload.addListener('completed', id, (data) => {
            if (data.responseCode >= 200 && data.responseCode < 300) {
              onProgress?.(1);
              resolve();
            } else {
              reject(new Error(`Upload failed (${data.responseCode})`));
            }
          }),
        );
        subs.push(
          Upload.addListener('error', id, (data) => {
            reject(new Error(data.error || 'Upload error'));
          }),
        );
        subs.push(
          Upload.addListener('cancelled', id, () => {
            reject(new Error('Upload cancelled'));
          }),
        );
      });
    } finally {
      cleanup();
    }
  })();

  return {
    done,
    cancel: () => {
      cancelled = true;
      void Upload.cancelUpload(uploadId).catch(() => undefined);
    },
  };
};
