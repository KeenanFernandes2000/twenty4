// upload/types — the transfer-subsystem contract (M6).
//
// This module defines the PUT-to-presigned-S3 contract shared by BOTH platform
// implementations (transfer.native.ts / transfer.web.ts) and the type face
// (transfer.ts). It is platform-agnostic: no react-native / expo imports here,
// so it bundles identically on web and native.
//
// The subsystem PUTs raw file bytes to an already-host-correct presigned S3 URL
// with progress + cancel. Cancellation is surfaced as a DISTINCT error
// (UploadAbortedError) so callers can tell "user cancelled" from "upload failed".

/**
 * Progress callback. Fraction is 0..1, monotonic non-decreasing, and reaches
 * exactly 1 when the PUT returns 2xx. Never called after done settles.
 */
export type UploadProgress = (fraction: number) => void;

export interface PutFileArgs {
  /** Presigned S3 PUT URL (already host-correct from the API). */
  uploadUrl: string;
  /**
   * Source bytes. NATIVE: a full `file://` URI (scheme NOT stripped — the
   * expo-file-system legacy uploader requires it). WEB: a blob:/data:/http URL
   * that `fetch().blob()` can read.
   */
  uri: string;
  /**
   * Declared content type, sent as the PUT `Content-Type` header. S3's presign
   * and the server's HeadObject gate both require this to match, so it is
   * always sent — on every platform.
   */
  contentType: string;
  /** Optional, for logging / progress sanity only. */
  byteSize?: number;
  onProgress?: UploadProgress;
}

export interface PutFileHandle {
  /**
   * Resolves when the PUT returns 2xx. Rejects on HTTP error, network error,
   * or cancel. A cancel rejection is an {@link UploadAbortedError} — use
   * {@link isAbortError} to distinguish it from a genuine failure.
   */
  done: Promise<void>;
  /**
   * Aborts an in-flight OR not-yet-sent upload and makes `done` reject with an
   * {@link UploadAbortedError}. Synchronously available the instant putFile()
   * returns. Idempotent — calling it more than once is a no-op.
   */
  cancel: () => void;
}

export type PutFile = (args: PutFileArgs) => PutFileHandle;

/**
 * Distinct error type for user-initiated cancellation. Callers compare via
 * {@link isAbortError} (or `err.name === "UploadAbortedError"`) to branch
 * "cancelled" vs "failed" without coupling to the class identity across the
 * Metro platform split.
 */
export class UploadAbortedError extends Error {
  override readonly name = 'UploadAbortedError';
  constructor(message = 'upload aborted') {
    super(message);
    // Restore prototype chain for instanceof under transpiled targets.
    Object.setPrototypeOf(this, UploadAbortedError.prototype);
  }
}

/**
 * True iff `e` represents a cancellation. Name-based (not instanceof) so it
 * holds across module/realm boundaries introduced by the platform split.
 */
export function isAbortError(e: unknown): e is UploadAbortedError {
  return (
    e instanceof UploadAbortedError ||
    (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'UploadAbortedError')
  );
}
