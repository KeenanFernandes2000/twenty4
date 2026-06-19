/**
 * Upload orchestration (Slice 2) — the pipeline that turns a picked/captured
 * asset into a server-side `daily_media_item`.
 *
 * Flow (per task):
 *   1. POST /media (init): server resolves the 4am day_bucket authoritatively,
 *      inserts a `pending` row, returns { id, uploadUrl, dayBucket }.
 *   2. PUT bytes → uploadUrl via `putFile` (background-upload native / XHR web),
 *      streaming 0..1 progress into the uploadStore.
 *   3. POST /media/:id/complete → row enters `validating`, enqueues validate job.
 *   4. Invalidate the Today query so the new item appears.
 *
 * Web-safe: imports the `./transfer` barrel only (Metro resolves .web there), so
 * no native module is reachable from web. The actual pick/capture entry points
 * (camera/gallery) ARE native-only and live in their own screens.
 */
import { resolveDayBucket } from '@twenty4/contracts/dayWindow';
import type { MediaInitRequest } from '@twenty4/contracts/dto';

import { apiClient } from '../apiClient';
import { queryClient } from '../queryClient';
import { mediaKeys } from '../media';
import { useUploadStore, type UploadTask } from '../../stores/uploadStore';
import { putFile } from './transfer';

/** The current device IANA timezone (drives the client-mirror day-window). */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Client mirror of the server's bucket resolution (PLAN §5): we import the SAME
 * shared `resolveDayBucket` so the Today screen's optimistic "today" matches the
 * server — there is no second copy to drift. Used only for client-side display
 * hints; the server value on the row remains authoritative.
 */
export function clientDayBucket(at: Date = new Date(), tz: string = deviceTimezone()): string {
  return resolveDayBucket(at, tz);
}

/**
 * Run a single upload task end-to-end. Reads the task from the store by id so a
 * retry (which re-arms status + bumps attempt) re-runs with fresh state. Resolves
 * after `complete`; never throws (failures land on the store as `failed`).
 */
export async function runUpload(localId: string): Promise<void> {
  const store = useUploadStore.getState();
  const task = store.tasks[localId];
  if (!task) return;

  try {
    // 1. init — server resolves the bucket + presigns the PUT.
    const initBody: MediaInitRequest = {
      mediaType: task.meta.mediaType,
      contentType: task.meta.contentType,
      sizeBytes: task.meta.sizeBytes,
      capturedInApp: task.meta.capturedInApp,
      originalTimestamp: task.meta.originalTimestamp ?? null,
      deviceTimestamp: task.meta.deviceTimestamp ?? new Date().toISOString(),
      deviceTimezone: task.meta.deviceTimezone ?? deviceTimezone(),
      durationMs: task.meta.durationMs ?? null,
      width: task.meta.width,
      height: task.meta.height,
    };

    const init = await apiClient.media.init(initBody);
    useUploadStore.getState().patch(localId, {
      serverId: init.id,
      dayBucket: init.dayBucket,
      status: 'uploading',
    });

    // 2. PUT the bytes (background-upload native / XHR web), stream progress.
    const handle = putFile({
      url: init.uploadUrl,
      uri: task.uri,
      contentType: task.meta.contentType,
      uploadId: localId,
      onProgress: (fraction) => useUploadStore.getState().setProgress(localId, fraction),
    });
    await handle.done;

    // 3. complete — row → validating, enqueues validate-media job.
    await apiClient.media.complete(init.id);

    useUploadStore.getState().markDone(localId);

    // 4. refresh Today so the new item shows.
    void queryClient.invalidateQueries({ queryKey: mediaKeys.today() });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Upload failed. Tap to retry.';
    useUploadStore.getState().markFailed(localId, message);
  }
}

/** Enqueue + immediately start a task (the common pick/capture path). */
export function startUpload(
  input: Omit<UploadTask, 'progress' | 'status' | 'attempt' | 'createdAt'>,
): void {
  useUploadStore.getState().enqueue(input);
  void runUpload(input.localId);
}

/** Retry a failed task: re-arm in the store, then re-run the pipeline. */
export function retryUpload(localId: string): void {
  useUploadStore.getState().retry(localId);
  void runUpload(localId);
}
