// media — today-bucket query + readiness helpers (M6 read side).
//
// The state layer the today screen consumes:
//   • useTodayBucket()  — the GET /media/today query, with a self-stopping poll
//                         that runs WHILE the server is still validating items and
//                         stops once everything has settled.
//   • readiness()       — a pure summary over the items (counts + a "ready" hint
//                         that ≥ MONTAGE_MIN_MEDIA valid items enables "generate",
//                         matching the server floor so the gate never contradicts it).
//   • useDeleteMedia()  — an OPTIMISTIC delete mutation (remove-then-rollback).
//
// Imports are top-level: api/queryClient/queryKeys none of which import this
// module → no cycle. No screen is imported here.
import { useMutation, useQuery } from '@tanstack/react-query';
import { MONTAGE_MIN_MEDIA } from '@twenty4/contracts';
import type { MediaItemDTO, MediaTodayRes } from '@twenty4/contracts';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { queryKeys } from '@/lib/queryKeys';

// An item is "pending" (worker is actively validating it) iff its processingStatus
// is `validating` — i.e. it just completed and the worker is running. We do NOT
// treat `uploaded` as pending: that's an init'd-but-never-completed ORPHAN row, not
// in-flight validation, and treating it as pending would poll every 3s forever
// (battery/network drain). validationStatus==='pending' only counts in conjunction
// with the `validating` processing state. Once nothing is `validating`, the poll stops.
function isItemPending(item: MediaItemDTO): boolean {
  return (
    item.processingStatus === 'validating' && item.validationStatus === 'pending'
  );
}

// Does the today payload contain any still-validating item? Tolerates undefined
// (first load, before any data) → false (no reason to poll yet).
function hasPending(data: MediaTodayRes | undefined): boolean {
  return !!data?.items.some(isItemPending);
}

/**
 * The GET /media/today query. Polls every 3s WHILE any item is still being
 * validated by the background worker, then stops (returns false) once all items
 * have settled — so the list reflects valid/invalid transitions without manual
 * refresh, but we don't poll forever. The refetchInterval callback receives the
 * Query (react-query v5); we read its cached data off `q.state.data`.
 */
export function useTodayBucket() {
  return useQuery({
    queryKey: queryKeys.media.today,
    queryFn: () => api.getMediaToday(),
    refetchInterval: (q) => (hasPending(q.state.data) ? 3000 : false),
  });
}

export interface TodayReadiness {
  total: number;
  validCount: number;
  pendingCount: number;
  invalidCount: number;
  ready: boolean;
}

/**
 * Summarize today's items. `ready` gates the "Generate" CTA on ≥ MONTAGE_MIN_MEDIA
 * valid items — the SAME floor the server enforces (it 422s NOT_ENOUGH_MEDIA below
 * it), so the mobile gate never green-lights a generate the server would reject.
 */
export function readiness(items: MediaItemDTO[]): TodayReadiness {
  let validCount = 0;
  let pendingCount = 0;
  let invalidCount = 0;
  for (const item of items) {
    if (item.validationStatus === 'valid') validCount += 1;
    else if (item.validationStatus === 'invalid') invalidCount += 1;
    else pendingCount += 1; // 'pending'
  }
  return {
    total: items.length,
    validCount,
    pendingCount,
    invalidCount,
    ready: validCount >= MONTAGE_MIN_MEDIA,
  };
}

/**
 * Delete a media item with an OPTIMISTIC cache update: remove it from the
 * today list immediately, roll back on error, and reconcile with the server on
 * settle. mutationFn takes the media id. Mirrors the groups-screen
 * setQueryData/invalidate idiom, extended with the v5 onMutate/onError/onSettled
 * optimistic protocol.
 */
export function useDeleteMedia() {
  return useMutation<
    { status: 'deleted' },
    unknown,
    string,
    { previous: MediaTodayRes | undefined }
  >({
    mutationFn: (id) => api.deleteMedia(id),
    onMutate: async (id) => {
      // Cancel in-flight refetches so they don't clobber our optimistic write.
      await queryClient.cancelQueries({ queryKey: queryKeys.media.today });
      const previous = queryClient.getQueryData<MediaTodayRes>(queryKeys.media.today);
      // Optimistically drop the item from the cached today payload.
      if (previous) {
        queryClient.setQueryData<MediaTodayRes>(queryKeys.media.today, {
          ...previous,
          items: previous.items.filter((it) => it.id !== id),
        });
      }
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      // Roll back to the pre-mutation snapshot.
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.media.today, ctx.previous);
      }
    },
    onSettled: () => {
      // Reconcile with the server regardless of outcome.
      void queryClient.invalidateQueries({ queryKey: queryKeys.media.today });
    },
  });
}
