/**
 * toastStore — the global toast queue (7.x "Toasts/rollover").
 *
 * A single mounted host (ToastHost, in the root layout) subscribes here and
 * renders the active toast. Anywhere in the app can fire a toast WITHOUT threading
 * local state through every screen:
 *
 *   import { toast } from '../stores/toastStore';
 *   toast.success('Recap published.');
 *   toast.error('Couldn’t publish — try again.');
 *
 * Toasts auto-dismiss after `durationMs`; firing a new one supersedes the current
 * (last-wins, the "rollover" behavior). The presentational `Toast` primitive
 * (ui/Toast) renders the tone/message; this store owns lifecycle + placement.
 *
 * Web-safe: pure zustand + setTimeout, no native deps.
 */
import { create } from 'zustand';

import type { ToastTone } from '../ui';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastState {
  current: ToastItem | null;
  /** Show a toast (supersedes any current one). Returns its id. */
  show: (message: string, tone?: ToastTone, durationMs?: number) => number;
  /** Dismiss a specific toast (no-op if a newer one already replaced it). */
  dismiss: (id: number) => void;
}

const DEFAULT_DURATION_MS = 3000;
let nextId = 1;
let activeTimer: ReturnType<typeof setTimeout> | null = null;

export const useToastStore = create<ToastState>((set, get) => ({
  current: null,
  show: (message, tone = 'info', durationMs = DEFAULT_DURATION_MS) => {
    const id = nextId++;
    if (activeTimer) clearTimeout(activeTimer);
    set({ current: { id, message, tone } });
    activeTimer = setTimeout(() => get().dismiss(id), durationMs);
    return id;
  },
  dismiss: (id) => {
    const cur = get().current;
    if (cur && cur.id === id) {
      if (activeTimer) {
        clearTimeout(activeTimer);
        activeTimer = null;
      }
      set({ current: null });
    }
  },
}));

/**
 * Imperative helper so call sites (mutations, non-component code) can fire a
 * toast without a hook: `toast.success(...)`.
 */
export const toast = {
  show: (message: string, tone?: ToastTone, durationMs?: number) =>
    useToastStore.getState().show(message, tone, durationMs),
  info: (message: string, durationMs?: number) =>
    useToastStore.getState().show(message, 'info', durationMs),
  success: (message: string, durationMs?: number) =>
    useToastStore.getState().show(message, 'success', durationMs),
  error: (message: string, durationMs?: number) =>
    useToastStore.getState().show(message, 'error', durationMs),
};
