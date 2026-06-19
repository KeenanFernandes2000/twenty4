/**
 * Safety data layer — React Query over the api-client `safety` + `users` methods
 * (Slice 8): reports (6.1), blocks (6.2 / 5.5), and account deletion (5.6).
 *
 * - Blocking takes effect immediately server-side (the feed + every social action
 *   already filter BOTH directions, Slice 6). On the client we also invalidate
 *   the feed + the blocked list so the blocked author drops out of view at once.
 * - Query keys are centralized in `safetyKeys` so mutations invalidate exactly.
 *
 * Web-safe: no native-only imports.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError } from '@twenty4/api-client';
import type {
  BlockListResponse,
  CreateReportRequest,
  ReportResponse,
} from '@twenty4/contracts/dto';

import { apiClient } from './apiClient';
import { feedKeys } from './feed';
import { mockBlockedUsers, safetyMockActive } from './safetyMocks';

/* ------------------------------- error helper ------------------------------ */

export function safetyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

/* -------------------------------- query keys ------------------------------- */

export const safetyKeys = {
  all: ['safety'] as const,
  blocks: () => [...safetyKeys.all, 'blocks'] as const,
};

/* --------------------------------- queries --------------------------------- */

/** 5.5 — the caller's blocked-user list (newest-first, with user summaries). */
export function useBlockedUsers(options?: { enabled?: boolean }) {
  const mock = safetyMockActive();
  return useQuery<BlockListResponse>({
    queryKey: safetyKeys.blocks(),
    queryFn: async () => {
      if (mock) return { items: mockBlockedUsers() };
      return apiClient.safety.listBlocked();
    },
    enabled: options?.enabled ?? true,
  });
}

/* -------------------------------- mutations -------------------------------- */

/** 6.1 — report a montage | comment | user (idempotent on a repeat OPEN report). */
export function useReport() {
  return useMutation<ReportResponse, unknown, CreateReportRequest>({
    mutationFn: (input) => apiClient.safety.report(input),
  });
}

/**
 * 6.2 — block a user. Idempotent server-side; takes effect immediately. We
 * invalidate the feed (the author's recaps drop out) + the blocked list.
 */
export function useBlockUser() {
  const qc = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: (userId) => apiClient.safety.block(userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: feedKeys.all });
      void qc.invalidateQueries({ queryKey: safetyKeys.blocks() });
    },
  });
}

/** 5.5 — unblock a user (idempotent). Refreshes the feed + the blocked list. */
export function useUnblockUser() {
  const qc = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: (userId) => apiClient.safety.unblock(userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: feedKeys.all });
      void qc.invalidateQueries({ queryKey: safetyKeys.blocks() });
    },
  });
}

/** 5.6 — permanently delete the account → revokes sessions + enqueues purge. */
export function useDeleteAccount() {
  return useMutation<void, unknown, void>({
    mutationFn: () => apiClient.users.deleteMe(),
  });
}
