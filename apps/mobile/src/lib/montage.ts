/**
 * Montage data layer (Slice 5) — React Query over the api-client `montage`
 * methods. This is the wiring behind the create → review → publish flow:
 *
 *   - useMontageOptions()  GET /montages/options — themes + bundled music for the
 *     2.6 / 2.7 pickers (and the defaults the 2.5 review screen falls back to).
 *   - useMontage(id)       GET /montages/:id (§7.3 owner-only poll). Drives 2.4
 *     Generating: `refetchInterval` keeps polling WHILE status === 'generating'
 *     and stops the moment the server flips to draft_ready / published / failed.
 *   - useGenerate()        POST /montages — gate ≥ MONTAGE_MIN_VALID_MEDIA valid
 *     items today, one-active-per-day; enqueues render-montage (202 generating).
 *   - useRegenerate(id)    POST /montages/:id/regenerate — new theme/music →
 *     conditional reset back to generating (so 2.4 polls again).
 *   - usePublish(id)       POST /montages/:id/publish — idempotent multi-group
 *     publish; optimistically flips the cached montage to `published`.
 *   - useReplace(id)       POST /montages/:id/replace — Q2 republish-replace.
 *
 * Web-safe: pure React Query + the api-client; no native-only imports. The flow
 * screens also accept mock data (lib/montageMocks) for web-export screenshots,
 * so this layer is only exercised on a real device/session.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@twenty4/api-client';
import type {
  GenerateMontageRequest,
  RegenerateMontageRequest,
  PublishMontageRequest,
  ReplaceMontageRequest,
  MontageResponse,
  MontageGeneratingResponse,
  MontageOptionsResponse,
} from '@twenty4/contracts/dto';
import type { MontageStatus } from '@twenty4/contracts/enums';

import { apiClient } from './apiClient';

/* ------------------------------- error helpers ----------------------------- */

/** Friendly message for any montage error surfaced to the user. */
export function montageErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

/** Stable HTTP status of an ApiError (or undefined for non-API errors). */
export function montageErrorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}

/* -------------------------------- query keys ------------------------------- */

export const montageKeys = {
  all: ['montage'] as const,
  detail: (id: string) => [...montageKeys.all, 'detail', id] as const,
  options: () => [...montageKeys.all, 'options'] as const,
};

/* --------------------------------- queries --------------------------------- */

/** A terminal status no longer warrants polling. */
const TERMINAL: ReadonlySet<MontageStatus> = new Set<MontageStatus>([
  'draft_ready',
  'published',
  'failed',
  'deleted_by_user',
  'removed_by_admin',
  'expired',
  'not_generated',
]);

/**
 * §7.3 owner-only status poll + montage view. While `status === 'generating'`
 * we re-fetch every `pollMs` (default 2.5s) so 2.4 Generating advances to 2.5
 * Review (draft_ready) or render-failed (failed) without a manual refresh.
 * Polling stops automatically on any terminal status. A `notFound` flag is
 * surfaced for expired/deleted/removed → 404 (the screen routes home).
 */
export function useMontage(
  id: string | undefined,
  options?: { enabled?: boolean; pollMs?: number },
) {
  const pollMs = options?.pollMs ?? 2500;
  const query = useQuery<MontageResponse>({
    queryKey: montageKeys.detail(id ?? '∅'),
    queryFn: () => apiClient.montage.get(id as string),
    enabled: (options?.enabled ?? true) && !!id,
    retry: false,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (!status) return q.state.status === 'error' ? false : pollMs;
      return TERMINAL.has(status) ? false : pollMs;
    },
  });
  const notFound = montageErrorStatus(query.error) === 404;
  return { ...query, notFound };
}

/** Themes + bundled music for the 2.6 / 2.7 pickers (cached aggressively). */
export function useMontageOptions(options?: { enabled?: boolean }) {
  return useQuery<MontageOptionsResponse>({
    queryKey: montageKeys.options(),
    queryFn: () => apiClient.montage.options(),
    enabled: options?.enabled ?? true,
    staleTime: 30 * 60_000,
  });
}

/* -------------------------------- mutations -------------------------------- */

/**
 * POST /montages — generate today's montage. The server gates on
 * ≥ MONTAGE_MIN_VALID_MEDIA valid items + one-active-per-day, creates the row in
 * `generating`, and enqueues render-montage; the 202 returns { montageId }. The
 * caller then navigates to 2.4 and `useMontage(montageId)` takes over the poll.
 */
export function useGenerate() {
  return useMutation<MontageGeneratingResponse, unknown, GenerateMontageRequest>({
    mutationFn: (input) => apiClient.montage.create(input),
  });
}

/**
 * POST /montages/:id/regenerate — re-run with a new theme/music (2.6 / 2.7).
 * Only allowed while draft_ready|failed. On success the server conditionally
 * resets the montage to `generating`, so we seed that into the cache to make
 * 2.4 poll again immediately (no flash of the stale draft).
 */
export function useRegenerate(id: string) {
  const qc = useQueryClient();
  return useMutation<MontageGeneratingResponse, unknown, RegenerateMontageRequest>({
    mutationFn: (input) => apiClient.montage.regenerate(id, input),
    onSuccess: (res) => {
      qc.setQueryData<MontageResponse>(montageKeys.detail(id), (prev) =>
        prev ? { ...prev, status: res.status, videoUrl: null, thumbnailUrl: null } : prev,
      );
      void qc.invalidateQueries({ queryKey: montageKeys.detail(id) });
    },
  });
}

/**
 * POST /montages/:id/publish — idempotent multi-group publish (2.8). Optimistic:
 * flip the cached montage to `published` immediately so 2.9 renders without a
 * round-trip; the server response (published_at + expiry_at) reconciles it.
 */
export function usePublish(id: string) {
  const qc = useQueryClient();
  return useMutation<MontageResponse, unknown, { input: PublishMontageRequest; idempotencyKey?: string }>({
    mutationFn: ({ input, idempotencyKey }) => apiClient.montage.publish(id, input, idempotencyKey),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: montageKeys.detail(id) });
      const prev = qc.getQueryData<MontageResponse>(montageKeys.detail(id));
      if (prev) {
        qc.setQueryData<MontageResponse>(montageKeys.detail(id), { ...prev, status: 'published' });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      const c = ctx as { prev?: MontageResponse } | undefined;
      if (c?.prev) qc.setQueryData(montageKeys.detail(id), c.prev);
    },
    onSuccess: (res) => {
      qc.setQueryData<MontageResponse>(montageKeys.detail(id), res);
    },
  });
}

/**
 * POST /montages/:id/replace — Q2 republish-replace. `id` is the PRIOR (already
 * published) montage; the body carries the replacement id + its target groups.
 * Idempotent; on success the prior is superseded server-side.
 */
export function useReplace(priorId: string) {
  const qc = useQueryClient();
  return useMutation<MontageResponse, unknown, { input: ReplaceMontageRequest; idempotencyKey?: string }>({
    mutationFn: ({ input, idempotencyKey }) => apiClient.montage.replace(priorId, input, idempotencyKey),
    onSuccess: (res) => {
      qc.setQueryData<MontageResponse>(montageKeys.detail(res.id), res);
      void qc.invalidateQueries({ queryKey: montageKeys.detail(priorId) });
    },
  });
}
