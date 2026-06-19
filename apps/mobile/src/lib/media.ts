/**
 * Media data layer (Slice 2) — React Query over the api-client `media` methods.
 *
 * - `useTodayMedia` drives the 2.1 Today grid: GET /media/today?tz= with the
 *   caller's items + presigned previews + validCount. Polls while any item is
 *   still `validating` so the grid resolves valid/invalid without a manual
 *   refresh (the validate-media job runs server-side after `complete`).
 * - `useDeleteMedia` owner-hard-deletes a row (DELETE /media/:id); on success the
 *   download-url 404s. Optimistically drops the tile, rolls back on error.
 *
 * Web-safe: no native-only imports here (the byte transfer lives in lib/upload,
 * which itself is web-split). The Today screen renders on web with mock/empty
 * data for screenshots; this layer is the real wiring for the device.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@twenty4/api-client';
import type { TodayMediaResponse } from '@twenty4/contracts/dto';

import { apiClient } from './apiClient';

/** Centralized keys so mutations invalidate exactly. */
export const mediaKeys = {
  all: ['media'] as const,
  today: () => [...mediaKeys.all, 'today'] as const,
};

/** Friendly message for any media error surfaced to the user. */
export function mediaErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

/** The caller's current device IANA timezone (sent so the server scopes today). */
function deviceTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * 2.1 — today's collected items (+ presigned previews + validCount). Polls every
 * 4s while any item is still `validating` so the grid settles automatically.
 */
export function useTodayMedia(options?: { enabled?: boolean }) {
  const tz = deviceTz();
  return useQuery<TodayMediaResponse>({
    queryKey: mediaKeys.today(),
    queryFn: () => apiClient.media.today(tz),
    enabled: options?.enabled ?? true,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const stillValidating = data.items.some(
        (it) => it.validationStatus === 'pending',
      );
      return stillValidating ? 4000 : false;
    },
  });
}

/**
 * Owner hard-delete (DELETE /media/:id). Optimistically removes the tile from the
 * Today cache; rolls back on error. After success the download-url 404s (no leak).
 */
export function useDeleteMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.media.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: mediaKeys.today() });
      const prev = qc.getQueryData<TodayMediaResponse>(mediaKeys.today());
      if (prev) {
        const removed = prev.items.find((it) => it.id === id);
        qc.setQueryData<TodayMediaResponse>(mediaKeys.today(), {
          ...prev,
          items: prev.items.filter((it) => it.id !== id),
          validCount:
            removed?.validationStatus === 'valid'
              ? Math.max(0, prev.validCount - 1)
              : prev.validCount,
        });
      }
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(mediaKeys.today(), ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: mediaKeys.today() });
    },
  });
}
