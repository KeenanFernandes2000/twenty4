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
 *
 * FALLBACK: the background-upload native module is only present in a dev/release
 * build that bundled it — in Expo Go it is absent and `Upload.startUpload` would
 * throw "cannot read property 'startUpload' of undefined". When the native
 * module is unavailable we transparently fall back to the STREAMING, disk-backed
 * expo-file-system PUT (transfer.fileSystem.native.ts), which satisfies the SAME
 * { done, cancel } contract and reports 0..1 progress WITHOUT loading the whole
 * file into the JS heap (the old blob fallback OOM'd on large videos in Expo
 * Go). Real builds keep the background path.
 */
import { NativeModules } from 'react-native';
import Upload from 'react-native-background-upload';

import { putFileFileSystem } from './transfer.fileSystem.native';
import type { PutFile, PutFileHandle } from './transfer';

/**
 * The background-upload native module registers under different names per OS:
 * Android → `RNFileUploader`, iOS → `VydiaRNFileUploader`. If neither is present
 * (Expo Go), the JS `Upload.*` calls would deref `undefined`, so we route to the
 * foreground fallback instead.
 */
const hasBackgroundUploadModule = Boolean(
  NativeModules.RNFileUploader || NativeModules.VydiaRNFileUploader,
);

/** Warn once (dev only) when we first take the foreground fallback path. */
let warnedFallback = false;

export const putFile: PutFile = (opts): PutFileHandle => {
  if (!hasBackgroundUploadModule) {
    if (__DEV__ && !warnedFallback) {
      warnedFallback = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[upload] native background-upload module unavailable — using foreground fallback (expected in Expo Go)',
      );
    }
    return putFileFileSystem(opts);
  }

  return putFileBackground(opts);
};

const putFileBackground: PutFile = ({
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
