// montage — the M7 montage query layer (read + publish side).
//
// The state the generating/review screens consume:
//   • useMontage(id)        — GET /montages/:id, self-stopping poll WHILE the
//                             render is `generating`; stops once it settles to
//                             draft_ready / failed / published.
//   • useMontageOptions()   — GET /montages/options (themes + bundled tracks) for
//                             the theme/music picker.
//   • usePublishMontage()   — the publish mutation; invalidates the polled montage.
//
// Imports are top-level (api/queryClient/queryKeys — none import this module → no
// cycle). No screen is imported here. Mirrors @/lib/media's idioms (the
// refetchInterval-callback poll that reads q.state.data).
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  MontageDTO,
  MontageStatus,
  PublishMontageReq,
  PublishMontageRes,
  ReplaceMontageRes,
} from '@twenty4/contracts';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { queryKeys } from '@/lib/queryKeys';

// The render is "in flight" iff the server still reports `generating`. Once it
// reaches any terminal/reviewable state we stop polling.
function isGenerating(status: MontageStatus | undefined): boolean {
  return status === 'generating';
}

/**
 * GET /montages/:id with a self-stopping poll: refetch every 2.5s WHILE the
 * montage is still `generating`, then stop (returns false) once it flips to
 * draft_ready / failed / published. The refetchInterval callback receives the
 * Query (react-query v5); we read its cached data off `q.state.data`. `enabled`
 * is gated on a truthy id so the host screen can mount before the id resolves.
 */
export function useMontage(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.montage.detail(id ?? ''),
    queryFn: () => api.getMontage(id as string),
    enabled: !!id,
    refetchInterval: (q) => (isGenerating(q.state.data?.status) ? 2500 : false),
  });
}

/**
 * GET /montages/options — the theme + bundled-track list feeding the picker.
 * Options are effectively static for a session, so cache them generously.
 */
export function useMontageOptions() {
  return useQuery({
    queryKey: queryKeys.montage.options,
    queryFn: () => api.getMontageOptions(),
    staleTime: 5 * 60_000,
  });
}

/**
 * Publish a draft montage to one or more groups. On success we seed the publish
 * response into the montage cache (so the review screen flips to published
 * without waiting for a refetch) and invalidate to reconcile.
 */
export function usePublishMontage() {
  return useMutation<PublishMontageRes, unknown, { id: string; body: PublishMontageReq }>({
    mutationFn: ({ id, body }) => api.publishMontage(id, body),
    onSuccess: (res, { id }) => {
      // Patch the cached montage to the published shape immediately.
      const prev = queryClient.getQueryData<MontageDTO>(queryKeys.montage.detail(id));
      if (prev) {
        queryClient.setQueryData<MontageDTO>(queryKeys.montage.detail(id), {
          ...prev,
          status: res.status,
          publishedAt: res.publishedAt,
          expiryAt: res.expiryAt,
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.montage.detail(id) });
    },
  });
}

/**
 * M9 replace-before-expiry: generate a REPLACEMENT for a published recap. The
 * server creates a NEW montage (status `generating`) and, on the new montage's
 * successful publish, hard-deletes the prior recap + ALL its reactions/comments.
 * Returns the new montage's `{montageId,status}` so the caller can route into the
 * host screen (generate → review) for the replacement. The destructive-confirm copy
 * (prior reactions/comments are discarded) lives at the call site.
 */
export function useReplaceMontage() {
  return useMutation<ReplaceMontageRes, unknown, { id: string }>({
    mutationFn: ({ id }) => api.replaceMontage(id),
  });
}
