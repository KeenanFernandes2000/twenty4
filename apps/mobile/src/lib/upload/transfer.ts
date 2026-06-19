/**
 * transfer — the byte-PUT contract, platform-split via Metro extensions.
 *
 * `putFile` uploads the local file at `uri` to a presigned PUT `url`, reporting
 * 0..1 progress. Two implementations exist:
 *   - transfer.native.ts → react-native-background-upload (true background /
 *     resumable, survives app backgrounding; the spec's hard requirement).
 *   - transfer.web.ts    → XHR/fetch foreground upload with progress events.
 *
 * Metro picks `.native` on iOS/Android and `.web` on web automatically, so this
 * barrel never imports a native module on a web-reachable path. Callers import
 * from `./transfer` only.
 */
export interface PutFileOptions {
  /** Presigned PUT URL (S3/MinIO raw bucket). */
  url: string;
  /** Local file URI (file:// native, blob:/data: web). */
  uri: string;
  /** Object content-type — must match what the presign was signed with. */
  contentType: string;
  /** Stable id used as the background-upload task id (cancel/retry). */
  uploadId: string;
  /** 0..1 progress callback. */
  onProgress?: (fraction: number) => void;
  /** Abort signal (web; native cancels via cancel()). */
  signal?: AbortSignal;
}

export interface PutFileHandle {
  /** Resolves on success; rejects on HTTP error / network failure. */
  done: Promise<void>;
  /** Best-effort cancel of an in-flight transfer. */
  cancel: () => void;
}

export type PutFile = (opts: PutFileOptions) => PutFileHandle;

/**
 * Base `putFile` — never actually invoked: Metro resolves `transfer.native.ts`
 * on iOS/Android and `transfer.web.ts` on web, both of which export a real
 * `putFile`. This base export exists so TypeScript (which resolves `./transfer`
 * → `transfer.ts`) sees a typed value. If it ever runs, the platform split is
 * misconfigured.
 */
export const putFile: PutFile = () => {
  throw new Error('putFile: no platform implementation resolved (transfer.native/web missing)');
};
