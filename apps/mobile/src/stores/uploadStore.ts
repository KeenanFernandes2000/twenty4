// uploadStore — the M6 upload-manager queue (zustand).
//
// Models a client-side queue of media uploads. Each item runs the 3-call server
// pipeline: mediaInit (presign) → PUT bytes to the presigned URL (progress) →
// mediaComplete (finalize + enqueue async validation). After complete the item is
// "done" UPLOADING — the server still validates it in the background (it becomes
// valid/invalid LATER), so "done" here is NOT "validated"; the today list (see
// @/lib/media) polls for that.
//
// Mirrors authStore's shape: `create<State>((set,get)=>({...}))`, immutable
// updates, convenience selector exports at the bottom.
//
// ── Circular-import safety ───────────────────────────────────────────────────
// We import `api`, `queryClient`, `queryKeys`, and `putFile`/`statSize`/
// `isAbortError` at module top. NONE of those import uploadStore, so there's no
// cycle (unlike authStore↔api, which must defer). Do NOT import any screen here.
//
// ── Cancel handles are kept OUT of React state ───────────────────────────────
// A live PutFileHandle holds a `cancel()` closure over network/native resources;
// it is not serializable and would cause needless re-renders if stored in zustand
// state. We keep a module-level `Map<localId, PutFileHandle>` instead — purely
// imperative, never read during render. cancel()/remove() reach into it; runItem
// always deletes from it in a `finally`.
import { create } from 'zustand';
import { ApiError } from '@twenty4/api-client';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { queryKeys } from '@/lib/queryKeys';
import { putFile, statSize, isAbortError, type PutFileHandle } from '@/lib/upload';

// Per-item terminal/in-flight states. "completing" is the mediaComplete call;
// "done" means uploaded+finalized (server-side validation happens AFTER).
export type UploadStatus =
  | 'queued'
  | 'uploading'
  | 'completing'
  | 'done'
  | 'failed'
  | 'canceled';

// What a screen hands us to upload. byteSize/deviceCapturedAt are optional: the
// image picker gives fileSize for photos, the camera knows captured-at = now;
// when omitted the store resolves byteSize via statSize and omits capturedAt.
export interface UploadAsset {
  uri: string; // file:// (native) or blob:/data: (web)
  mediaType: 'photo' | 'video';
  contentType: string; // from the MIME allowlist (picker mimeType or inferred)
  byteSize?: number;
  fileName?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  deviceCapturedAt?: string; // ISO 8601 w/ offset, when known; else omit
  // Lowest-trust client-declared original timestamp (ISO 8601 w/ offset; `Z` counts
  // as an offset). Imports declare "now" so no-EXIF media can validate as today; the
  // worker still prefers EXIF/media-library and rejects EXIF that proves it's older.
  declaredOriginalTimestamp?: string;
}

export interface UploadItem {
  localId: string; // client id (NOT the server media id)
  asset: UploadAsset;
  status: UploadStatus;
  progress: number; // 0..1
  error?: string; // human-readable, set on failed
  mediaId?: string; // server id once init returns
}

export interface UploadState {
  items: UploadItem[];
  // Actions
  enqueue: (assets: UploadAsset[]) => void;
  retry: (localId: string) => void;
  cancel: (localId: string) => void;
  remove: (localId: string) => void;
  clearFinished: () => void;
}

// ── Module-level (non-reactive) collaborators ────────────────────────────────
// Max concurrent in-flight uploads. Pump fills freed slots as items settle.
const CONCURRENCY = 3;

// Live cancel handles — see the "kept OUT of React state" note above.
const handles = new Map<string, PutFileHandle>();

// Monotonic counter for unique localIds (avoids Math.random per the spec; the
// counter + uri is unique per session even if the same asset is enqueued twice).
let seq = 0;
function nextLocalId(uri: string): string {
  seq += 1;
  return `u${seq}:${uri}`;
}

// Clamp a progress fraction to [0,1]; defends against transports that overshoot.
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Compute the device's IANA timezone once per call (mediaInit requires it).
// Falls back to "UTC" if Intl is unavailable or throws.
function getDeviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// Map an upload failure to a friendly message. Prefers known ApiError codes; the
// MEDIA_TOO_LARGE case only surfaces at complete-time (server HeadObject gate).
function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'DAILY_LIMIT_REACHED':
        return 'Daily limit reached (50/day)';
      case 'MEDIA_TYPE_NOT_ALLOWED':
        return "That file type isn't supported";
      case 'MEDIA_TOO_LARGE':
        return 'File is too large (max 200MB)';
      default:
        return err.message || 'Upload failed';
    }
  }
  return err instanceof Error && err.message ? err.message : 'Upload failed';
}

// Best-effort reclaim of the server-side daily_media_item row that mediaInit
// inserted. That row counts toward the 50/day cap the instant init succeeds —
// regardless of whether PUT/complete ever happen — so retry/cancel/remove must
// delete the orphan to avoid exhausting the cap and breeding `uploaded` orphans.
// Swallows errors: the M9 server sweep backstops any delete that fails here.
async function reclaimRow(mediaId?: string): Promise<void> {
  if (!mediaId) return;
  try {
    await api.deleteMedia(mediaId);
  } catch {
    /* best-effort; M9 sweep backstops */
  }
}

export const useUploadStore = create<UploadState>((set, get) => {
  // ── Internal helpers (closures over set/get; not exposed on the store) ──────

  // Immutable patch of a single item by localId (no-op if it's gone — e.g.
  // remove() raced an in-flight update).
  const patch = (localId: string, p: Partial<UploadItem>) => {
    set((s) => ({
      items: s.items.map((it) => (it.localId === localId ? { ...it, ...p } : it)),
    }));
  };

  // Count items occupying an in-flight slot (anything not yet terminal that the
  // pump has started — uploading/completing). Queued items are NOT in-flight.
  const inFlightCount = () =>
    get().items.filter((it) => it.status === 'uploading' || it.status === 'completing').length;

  // Concurrency-capped scheduler. Start queued items until the in-flight cap is
  // hit or the queue drains. Idempotent — runItem calls it again after each
  // terminal transition to fill the freed slot.
  const pump = () => {
    while (inFlightCount() < CONCURRENCY) {
      const next = get().items.find((it) => it.status === 'queued');
      if (!next) break;
      // Flip to uploading SYNCHRONOUSLY so the next loop iteration counts it as
      // in-flight (prevents over-scheduling past CONCURRENCY before the async
      // runItem flips it).
      patch(next.localId, { status: 'uploading', progress: 0, error: undefined });
      void runItem(next.localId);
    }
  };

  // Per-item pipeline. Assumes the item is already flipped to 'uploading' by the
  // pump. Always pump() again on a terminal state, and always drop the handle.
  const runItem = async (localId: string) => {
    const item = get().items.find((it) => it.localId === localId);
    if (!item) return;
    const { asset } = item;

    try {
      // 1. Resolve byteSize (picker may not provide it). A non-positive/NaN size
      // is unusable — mediaInit requires a positive int — so fail clearly here
      // rather than sending a bad request.
      const byteSize = asset.byteSize ?? (await statSize(asset.uri));
      if (!Number.isFinite(byteSize) || byteSize <= 0) {
        patch(localId, { status: 'failed', error: 'Could not read file size' });
        return;
      }

      const deviceTimezone = getDeviceTimezone();

      // 2. Init → presigned uploadUrl + server id.
      const init = await api.mediaInit({
        mediaType: asset.mediaType,
        contentType: asset.contentType,
        byteSize,
        deviceTimezone,
        deviceCapturedAt: asset.deviceCapturedAt,
        declaredOriginalTimestamp: asset.declaredOriginalTimestamp,
      });
      patch(localId, { mediaId: init.id });

      // 3. PUT the raw bytes (streams from disk on native). Stash the live handle
      // so cancel() can abort it; progress drives the bar.
      const handle = putFile({
        uploadUrl: init.uploadUrl,
        uri: asset.uri,
        contentType: asset.contentType,
        byteSize,
        onProgress: (f) => patch(localId, { progress: clamp01(f) }),
      });
      handles.set(localId, handle);
      await handle.done;

      // 4. Complete → finalize + enqueue async validation (still "validating").
      patch(localId, { status: 'completing' });
      await api.mediaComplete(init.id);

      // 5. Done uploading. Mark done, then AWAIT the today invalidation so the
      // server bucket refetch settles (v5 resolves after active refetches finish)
      // BEFORE dropping the local card — gap-free hand-off, no lingering hidden
      // done item. The item leaves the local list only after the server list shows it.
      patch(localId, { status: 'done', progress: 1, error: undefined });
      await queryClient.invalidateQueries({ queryKey: queryKeys.media.today });
      set((s) => ({ items: s.items.filter((it) => it.localId !== localId) }));
    } catch (err) {
      if (isAbortError(err)) {
        // User cancelled — not a failure. (cancel() already set 'canceled', but
        // set it here too in case the abort came from the transport directly.)
        patch(localId, { status: 'canceled' });
      } else {
        patch(localId, { status: 'failed', error: friendlyError(err) });
      }
    } finally {
      // Always drop the live handle and refill the freed concurrency slot.
      handles.delete(localId);
      pump();
    }
  };

  return {
    items: [],

    enqueue: (assets) => {
      const newItems: UploadItem[] = assets.map((asset) => ({
        localId: nextLocalId(asset.uri),
        asset,
        status: 'queued' as const,
        progress: 0,
      }));
      set((s) => ({ items: [...s.items, ...newItems] }));
      pump();
    },

    retry: (localId) => {
      // Reclaim the predecessor's orphan server row (init inserted one, counting
      // toward the 50/day cap) BEFORE re-queuing — otherwise each retry re-inits a
      // NEW row and repeated retries exhaust the cap. Fire the delete, then reset.
      const item = get().items.find((it) => it.localId === localId);
      void reclaimRow(item?.mediaId);
      // Reset a failed/canceled item back to queued; clear prior error/progress/
      // mediaId so the pipeline re-runs from scratch.
      patch(localId, {
        status: 'queued',
        progress: 0,
        error: undefined,
        mediaId: undefined,
      });
      pump();
    },

    cancel: (localId) => {
      const item = get().items.find((it) => it.localId === localId);
      if (!item) return;
      // Only `queued` and `uploading` are cancelable. Once we're `completing` the
      // PUT already succeeded and mediaComplete is in flight — canceling would lie
      // (server still finishes) and cause a canceled→done flip-flop. `done`/`failed`/
      // `canceled` are terminal. No-op for all of these.
      if (item.status !== 'queued' && item.status !== 'uploading') return;
      if (item.status === 'uploading') {
        // Abort the live transfer (its done rejects with UploadAbortedError;
        // runItem's catch maps that to 'canceled'). The handle is dropped by
        // runItem's finally. A server row exists from init → reclaim it so the
        // canceled upload's row doesn't linger and eat the 50/day cap.
        handles.get(localId)?.cancel();
        void reclaimRow(item.mediaId);
      }
      // `queued` has no mediaId/handle yet — nothing to abort or reclaim.
      patch(localId, { status: 'canceled' });
    },

    remove: (localId) => {
      const item = get().items.find((it) => it.localId === localId);
      // Reclaim the orphan server row for terminal-but-not-done items so removing
      // the card frees the cap slot. NEVER reclaim `done` — those are legitimately
      // uploaded and live in the today bucket; deleting the card must not delete
      // the user's media.
      if (item && (item.status === 'failed' || item.status === 'canceled')) {
        void reclaimRow(item.mediaId);
      }
      // Abort if in-flight, then drop from the list entirely.
      handles.get(localId)?.cancel();
      handles.delete(localId);
      set((s) => ({ items: s.items.filter((it) => it.localId !== localId) }));
      // A freed slot may let a queued item start.
      pump();
    },

    clearFinished: () => {
      // Drop only `failed` + `canceled` items. `done` items now self-remove after
      // the gap-free server hand-off (runItem awaits the today invalidate, then
      // removes), so they never linger here to be cleared.
      set((s) => ({
        items: s.items.filter((it) => it.status !== 'failed' && it.status !== 'canceled'),
      }));
    },
  };
});

// ── Convenience selectors ────────────────────────────────────────────────────
// Slice-narrow subscriptions to avoid re-render storms:
//   const items = useUploadItems();
//   const active = useActiveUploadCount();
export const useUploadItems = () => useUploadStore((s) => s.items);
export const useActiveUploadCount = () =>
  useUploadStore(
    (s) =>
      s.items.filter(
        (i) => i.status === 'uploading' || i.status === 'completing' || i.status === 'queued',
      ).length,
  );
