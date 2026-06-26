// montageStore — the M7 in-flight-montage tracker (zustand).
//
// Models the ONE montage a user is generating/reviewing for today. The render is
// a server-side job: `startGenerate` POSTs /montages (202 → {montageId,status}),
// stashes the id, and navigates to the montage host screen; that screen then
// react-query-polls GET /montages/:id (see @/lib/montage) until the status flips
// to draft_ready / failed. `regenerate` re-enqueues (optionally with a trimmed
// `mediaIds` for remove-and-regenerate).
//
// Mirrors uploadStore's shape: `create<State>((set,get)=>({...}))`, immutable
// updates, slice-selector exports at the bottom.
//
// ── Circular-import safety ───────────────────────────────────────────────────
// Imports `api`, `queryClient`, `queryKeys`, and expo-router's imperative `router`
// at module top. NONE of those import this store, so there's no cycle (same as
// uploadStore). The imperative `router` is the documented way to navigate from
// outside a component; it queues until the router is mounted.
import { create } from 'zustand';
import { router } from 'expo-router';
import { ApiError } from '@twenty4/api-client';
import type { CreateMontageReq, MontageStatus, RegenerateMontageReq } from '@twenty4/contracts';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { queryKeys } from '@/lib/queryKeys';

// The montage we're currently generating / reviewing (null when none in flight).
export interface CurrentMontage {
  id: string;
  status: MontageStatus;
}

export interface MontageState {
  /** The montage created this session (drives the host screen route + generate CTA). */
  current: CurrentMontage | null;
  /** True while the POST /montages (or regenerate) request is in flight. */
  starting: boolean;
  /** Human-readable failure of the LAST start/regenerate call (cleared on retry). */
  error: string | null;
  // Actions
  startGenerate: (opts?: CreateMontageReq) => Promise<void>;
  /**
   * Re-enqueue the render. `mediaIds` (trimmed subset) = remove-and-regenerate;
   * `theme`/`musicId` carry the review-screen picker selections so a regenerate
   * re-skins the render. All fields optional; omitted ones keep the row's value.
   */
  regenerate: (id: string, opts?: RegenerateMontageReq) => Promise<void>;
  /** Let the poll hook push the freshest status back into the store. */
  syncStatus: (id: string, status: MontageStatus) => void;
  clear: () => void;
}

// Map a montage start/regenerate failure to a friendly message. Prefers known
// ApiError codes; everything else degrades to the raw message.
function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'NOT_ENOUGH_MEDIA':
        return 'Add a few more photos or videos to generate a montage';
      case 'MONTAGE_ALREADY_GENERATING':
        return "You're already generating today's montage";
      case 'RENDER_FAILED_RETRYABLE':
        return 'Render failed — please try again';
      default:
        return err.message || 'Could not start the montage';
    }
  }
  return err instanceof Error && err.message ? err.message : 'Could not start the montage';
}

export const useMontageStore = create<MontageState>((set, get) => ({
  current: null,
  starting: false,
  error: null,

  startGenerate: async (opts) => {
    // Guard against a double-tap kicking off two POSTs.
    if (get().starting) return;
    set({ starting: true, error: null });
    try {
      const res = await api.createMontage(opts ?? {});
      set({ current: { id: res.montageId, status: res.status } });
      // Navigate to the host screen; it polls GET /montages/:id from here. Inline
      // the template literal (mirrors the groups screen) so typed-routes infers the
      // dynamic-segment Href contextually rather than widening to `string`.
      router.push(`/(app)/montage/${res.montageId}`);
    } catch (err) {
      set({ error: friendlyError(err) });
      throw err;
    } finally {
      set({ starting: false });
    }
  },

  regenerate: async (id, opts) => {
    if (get().starting) return;
    set({ starting: true, error: null });
    try {
      // Build the body, omitting undefined fields (never send null/undefined):
      //   • mediaIds (trimmed subset) = remove-and-regenerate; omitted → server
      //     reuses source_media_ids.
      //   • theme/musicId = the picker selections; omitted → keep the row's value.
      const body: RegenerateMontageReq = {};
      if (opts?.mediaIds) body.mediaIds = opts.mediaIds;
      if (opts?.theme) body.theme = opts.theme;
      if (opts?.musicId) body.musicId = opts.musicId;
      const res = await api.regenerateMontage(id, body);
      set({ current: { id: res.montageId, status: res.status } });
      // Optimistically flip the cached montage back to `generating` so the host
      // screen shows the progress state immediately, then force a refetch so the
      // poll loop (refetchInterval) restarts.
      void queryClient.invalidateQueries({ queryKey: queryKeys.montage.detail(res.montageId) });
    } catch (err) {
      set({ error: friendlyError(err) });
      throw err;
    } finally {
      set({ starting: false });
    }
  },

  syncStatus: (id, status) => {
    const cur = get().current;
    if (cur && cur.id === id && cur.status !== status) {
      set({ current: { id, status } });
    }
  },

  clear: () => set({ current: null, starting: false, error: null }),
}));

// ── Convenience selectors ────────────────────────────────────────────────────
// Slice-narrow subscriptions (mirrors uploadStore):
//   const start = useMontageStore((s) => s.startGenerate);
//   const starting = useMontageStarting();
export const useMontageStarting = () => useMontageStore((s) => s.starting);
export const useMontageError = () => useMontageStore((s) => s.error);
export const useCurrentMontage = () => useMontageStore((s) => s.current);
