/**
 * uploadStore — in-flight media uploads (Slice 2).
 *
 * The Today capture/gallery flows create an upload TASK here the moment the
 * user picks/captures, so the UI can show per-item progress + retry BEFORE the
 * server round-trip finishes. Each task tracks the local asset (uri + metadata),
 * the resolved server id/uploadUrl (once `init` returns), a 0..1 progress, and a
 * status: queued → uploading → done | failed.
 *
 * The store is deliberately platform-agnostic: it holds STATE only. The actual
 * byte transfer (background-upload native / fetch web) lives in lib/upload, which
 * drives this store via the exposed setters. This keeps the store importable on
 * every platform (web export must not pull native modules).
 *
 * `retry` re-arms a failed task back to `queued` and bumps `attempt`; the upload
 * runner re-reads it. `clearFinished` prunes done/failed items from the tray.
 */
import { create } from 'zustand';

import type { MediaType } from '@twenty4/contracts/enums';
import type { UploadMime } from '@twenty4/contracts/dto';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed';

/** Client-side capture metadata captured at pick/capture time (sent on init). */
export interface UploadMetadata {
  mediaType: MediaType;
  contentType: UploadMime;
  sizeBytes: number;
  /** True only for the in-app camera path (trusted → auto-valid §6). */
  capturedInApp: boolean;
  /** Best-resolved capture time (EXIF→media-lib→file), ISO; null if unknown. */
  originalTimestamp?: string | null;
  /** Device clock at upload (anti-tamper delta vs server, §6). */
  deviceTimestamp?: string;
  /** Device IANA tz — drives the authoritative 4am day-window (§6 Q3). */
  deviceTimezone?: string;
  durationMs?: number | null;
  width?: number;
  height?: number;
}

export interface UploadTask {
  /** Stable local id (also used as the bg-upload customUploadId). */
  localId: string;
  /** Local file URI to read bytes from (file:// or blob: on web). */
  uri: string;
  /** Human label for the tray (filename or "Camera capture"). */
  label: string;
  /** 0..1 transfer progress. */
  progress: number;
  status: UploadStatus;
  /** Retry counter (0 on first attempt). */
  attempt: number;
  /** Friendly error message when status === 'failed'. */
  error?: string;
  /** Server `daily_media_item` id once init succeeds. */
  serverId?: string;
  /** Server-resolved 4am bucket (informational). */
  dayBucket?: string;
  /** When the task was created (ms epoch) — newest-first ordering. */
  createdAt: number;
  /** The metadata sent to POST /media. */
  meta: UploadMetadata;
}

interface UploadState {
  tasks: Record<string, UploadTask>;
  /** Newest-first list for the tray. */
  order: string[];

  /** Insert a freshly-picked task (status `queued`). */
  enqueue: (task: Omit<UploadTask, 'progress' | 'status' | 'attempt' | 'createdAt'>) => void;
  /** Patch any fields on a task (no-op if missing). */
  patch: (localId: string, patch: Partial<UploadTask>) => void;
  /** Convenience: set progress (clamped 0..1) + mark `uploading`. */
  setProgress: (localId: string, progress: number) => void;
  /** Mark done at 100%. */
  markDone: (localId: string) => void;
  /** Mark failed with a message. */
  markFailed: (localId: string, error: string) => void;
  /** Re-arm a failed task to `queued`, bumping `attempt`. */
  retry: (localId: string) => void;
  /** Remove a single task. */
  remove: (localId: string) => void;
  /** Drop all done/failed tasks. */
  clearFinished: () => void;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export const useUploadStore = create<UploadState>((set) => ({
  tasks: {},
  order: [],

  enqueue: (task) =>
    set((s) => ({
      tasks: {
        ...s.tasks,
        [task.localId]: {
          ...task,
          progress: 0,
          status: 'queued',
          attempt: 0,
          createdAt: Date.now(),
        },
      },
      order: [task.localId, ...s.order.filter((id) => id !== task.localId)],
    })),

  patch: (localId, patch) =>
    set((s) => {
      const existing = s.tasks[localId];
      if (!existing) return s;
      return { tasks: { ...s.tasks, [localId]: { ...existing, ...patch } } };
    }),

  setProgress: (localId, progress) =>
    set((s) => {
      const existing = s.tasks[localId];
      if (!existing) return s;
      return {
        tasks: {
          ...s.tasks,
          [localId]: { ...existing, progress: clamp01(progress), status: 'uploading' },
        },
      };
    }),

  markDone: (localId) =>
    set((s) => {
      const existing = s.tasks[localId];
      if (!existing) return s;
      return {
        tasks: { ...s.tasks, [localId]: { ...existing, progress: 1, status: 'done', error: undefined } },
      };
    }),

  markFailed: (localId, error) =>
    set((s) => {
      const existing = s.tasks[localId];
      if (!existing) return s;
      return { tasks: { ...s.tasks, [localId]: { ...existing, status: 'failed', error } } };
    }),

  retry: (localId) =>
    set((s) => {
      const existing = s.tasks[localId];
      if (!existing) return s;
      return {
        tasks: {
          ...s.tasks,
          [localId]: {
            ...existing,
            status: 'queued',
            progress: 0,
            error: undefined,
            attempt: existing.attempt + 1,
          },
        },
      };
    }),

  remove: (localId) =>
    set((s) => {
      const { [localId]: _removed, ...rest } = s.tasks;
      return { tasks: rest, order: s.order.filter((id) => id !== localId) };
    }),

  clearFinished: () =>
    set((s) => {
      const kept = s.order.filter((id) => {
        const t = s.tasks[id];
        return t && t.status !== 'done' && t.status !== 'failed';
      });
      const tasks: Record<string, UploadTask> = {};
      for (const id of kept) tasks[id] = s.tasks[id];
      return { tasks, order: kept };
    }),
}));

/** Stable selector: active tasks (queued/uploading) count — for the badge. */
export function selectActiveCount(s: UploadState): number {
  return s.order.reduce((n, id) => {
    const t = s.tasks[id];
    return t && (t.status === 'queued' || t.status === 'uploading') ? n + 1 : n;
  }, 0);
}
