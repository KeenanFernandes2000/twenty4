// upload/transfer.foreground — XHR PUT implementation of PutFile.
//
// Used by the WEB build (transfer.web.ts re-exports putFile from here). On web,
// `fetch(uri).blob()` is acceptable: browser Blobs are backed by browser
// storage, not the JS heap, so the e2e drives ≤30MB files through here fine.
// (The NATIVE build must NOT use this — blob-in-heap OOMs big videos; see
// transfer.fileSystem.native.ts.)
//
// Failure modes pre-empted here:
//  - Content-Type is always set on the PUT (S3 presign + HeadObject gate).
//  - Abort-before-send: xhr.abort() is a silent no-op while UNSENT. We
//    `await fetch().blob()` BEFORE xhr.send(); a cancel() during that await
//    would be lost and send() would still fire. So we keep an `aborted` flag,
//    cancel() sets it (and defensively calls xhr.abort()), and BEFORE
//    xhr.send(blob) we bail (reject) if aborted is true.

import { UploadAbortedError, type PutFile } from './types';

export const putFile: PutFile = ({ uploadUrl, uri, contentType, onProgress }) => {
  const xhr = new XMLHttpRequest();

  // Closure state captured synchronously so cancel() works the instant
  // putFile() returns — even before the async blob fetch resolves.
  let aborted = false;
  let sent = false;
  // The Promise executor runs synchronously, so these are assigned before the
  // constructor returns; the `!` asserts that to TS.
  let resolveDone!: () => void;
  let rejectDone!: (e: unknown) => void;

  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;

    xhr.open('PUT', uploadUrl);
    // Always declare the content type — required by the S3 presign and the
    // server's HeadObject content-type gate.
    xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable && onProgress && e.total > 0) {
        onProgress(e.loaded / e.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
      } else {
        reject(new Error(`upload PUT failed: HTTP ${xhr.status}`));
      }
    };

    // Network-level failure (DNS, connection reset, CORS, etc.).
    xhr.onerror = () => reject(new Error('upload PUT failed: network error'));

    // Fired by xhr.abort() once the request has been sent.
    xhr.onabort = () => reject(new UploadAbortedError());
  });

  // Async body fetch runs INSIDE this IIFE (not before returning the handle),
  // so the handle — and its synchronous cancel() — is live immediately.
  void (async () => {
    let blob: Blob;
    try {
      const res = await fetch(uri);
      blob = await res.blob();
    } catch {
      rejectDone(new Error('upload PUT failed: could not read source bytes'));
      return;
    }
    // Abort-before-send guard: if cancel() landed during the await above,
    // xhr.send() would otherwise still fire (abort() was a no-op while UNSENT).
    if (aborted) {
      rejectDone(new UploadAbortedError());
      return;
    }
    sent = true;
    xhr.send(blob);
  })();

  const cancel = () => {
    if (aborted) return; // idempotent
    aborted = true;
    if (sent) {
      // Request is in flight — abort() fires onabort, which rejects `done`.
      xhr.abort();
    } else {
      // Not yet sent: abort() would be a silent no-op. Defensively call it
      // anyway, but the pre-send guard above is what actually rejects `done`.
      try {
        xhr.abort();
      } catch {
        // ignore
      }
    }
  };

  return { done, cancel };
};
