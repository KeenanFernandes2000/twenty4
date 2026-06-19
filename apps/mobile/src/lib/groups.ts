/**
 * Groups data layer — React Query queries + mutations over the api-client
 * `groups`/invites methods (Slice 4). Mirrors the auth data layer (lib/auth.ts):
 * each screen consumes a hook and reads `{ data, isLoading, error, … }` /
 * `{ mutate, isPending, error }`, rendering states with the Ember primitives.
 *
 * Query keys are centralized in `groupKeys` so mutations can invalidate exactly.
 * Mutations invalidate the list + the affected detail/members on success, and
 * a couple are optimistic where the UX clearly benefits (leave, remove member).
 *
 * Web-safe: no native-only imports.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { ApiError } from '@twenty4/api-client';
import type {
  CreateGroupRequest,
  UpdateGroupRequest,
  CreateInviteRequest,
  GroupResponse,
  GroupListResponse,
  InviteResponse,
  InvitePreviewResponse,
  MeResponse,
} from '@twenty4/contracts/dto';

import { apiClient } from './apiClient';
import type { GroupMembersResponse } from '@twenty4/api-client';

/* ------------------------------- error helpers ----------------------------- */

/** Friendly message for any error surfaced to the user. */
export function groupErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

/** Stable HTTP status of an ApiError (or undefined for non-API errors). */
export function errorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}

/** Read a `details.reason` discriminator off an ApiError body (e.g. `already_member`). */
export function errorReason(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const body = error.body as { details?: { reason?: unknown } } | undefined;
  const reason = body?.details?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

/* -------------------------------- query keys ------------------------------- */

export const groupKeys = {
  all: ['groups'] as const,
  list: () => [...groupKeys.all, 'list'] as const,
  detail: (id: string) => [...groupKeys.all, 'detail', id] as const,
  members: (id: string) => [...groupKeys.all, 'members', id] as const,
  invitePreview: (code: string) => ['invitePreview', code] as const,
};

/* ----------------------------------- me ------------------------------------ */

/** The signed-in user (for member-management permission checks: self / role). */
export function useMe() {
  return useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => apiClient.users.me(),
    staleTime: 5 * 60_000,
  });
}

/* --------------------------------- queries --------------------------------- */

/** 4.1 — the caller's active groups (member count + role per group). */
export function useGroups(options?: { enabled?: boolean }) {
  return useQuery<GroupListResponse>({
    queryKey: groupKeys.list(),
    queryFn: () => apiClient.groups.list(),
    enabled: options?.enabled ?? true,
  });
}

/** 4.2 — a single group the caller belongs to (403 → not a member). */
export function useGroup(id: string, options?: { enabled?: boolean }) {
  return useQuery<GroupResponse>({
    queryKey: groupKeys.detail(id),
    queryFn: () => apiClient.groups.get(id),
    enabled: options?.enabled ?? !!id,
  });
}

/** 4.2 / 4.6 — the group's active members (+ role + user summary). */
export function useGroupMembers(id: string, options?: { enabled?: boolean }) {
  return useQuery<GroupMembersResponse>({
    queryKey: groupKeys.members(id),
    queryFn: () => apiClient.groups.members(id),
    enabled: options?.enabled ?? !!id,
  });
}

/**
 * 4.5 — preview an invite by code (group name/photo/count + validity). Disabled
 * until a code is present (the join screen enables it once the user types/arrives
 * via deep link).
 */
export function useInvitePreview(
  code: string,
  options?: Pick<UseQueryOptions<InvitePreviewResponse>, 'enabled'>,
) {
  return useQuery<InvitePreviewResponse>({
    queryKey: groupKeys.invitePreview(code),
    queryFn: () => apiClient.groups.resolveInvite(code),
    enabled: (options?.enabled ?? true) && !!code,
    retry: false,
    staleTime: 0,
  });
}

/* -------------------------------- mutations -------------------------------- */

/** 4.3 — create a group (caller → owner). Invalidates the list. */
export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGroupRequest) => apiClient.groups.create(input),
    onSuccess: (group) => {
      qc.setQueryData(groupKeys.detail(group.id), group);
      void qc.invalidateQueries({ queryKey: groupKeys.list() });
    },
  });
}

/** 4.2 — update name/photo/status. Invalidates detail + list. */
export function useUpdateGroup(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateGroupRequest) => apiClient.groups.update(id, input),
    onSuccess: (group) => {
      qc.setQueryData(groupKeys.detail(id), group);
      void qc.invalidateQueries({ queryKey: groupKeys.list() });
    },
  });
}

/** 4.2 — owner-only archive. Invalidates the list. */
export function useArchiveGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.groups.archive(id),
    onSuccess: (_void, id) => {
      void qc.invalidateQueries({ queryKey: groupKeys.list() });
      qc.removeQueries({ queryKey: groupKeys.detail(id) });
    },
  });
}

/** 4.2 — leave a group (sole-owner-of-non-empty → 409). Invalidates the list. */
export function useLeaveGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.groups.leave(id),
    onSuccess: (_void, id) => {
      void qc.invalidateQueries({ queryKey: groupKeys.list() });
      qc.removeQueries({ queryKey: groupKeys.detail(id) });
    },
  });
}

/**
 * 4.6 — owner/admin removes a member. Optimistically drops the row from the
 * members cache; rolls back on error.
 */
export function useRemoveMember(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiClient.groups.removeMember(groupId, userId),
    onMutate: async (userId) => {
      await qc.cancelQueries({ queryKey: groupKeys.members(groupId) });
      const prev = qc.getQueryData<GroupMembersResponse>(groupKeys.members(groupId));
      if (prev) {
        qc.setQueryData<GroupMembersResponse>(groupKeys.members(groupId), {
          items: prev.items.filter((m) => m.user.id !== userId),
        });
      }
      return { prev };
    },
    onError: (_err, _userId, ctx) => {
      if (ctx?.prev) qc.setQueryData(groupKeys.members(groupId), ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: groupKeys.members(groupId) });
      void qc.invalidateQueries({ queryKey: groupKeys.detail(groupId) });
    },
  });
}

/** 4.4 — mint an invite code (owner/admin; expiry + use-cap). */
export function useCreateInvite(groupId: string) {
  return useMutation<InviteResponse, unknown, CreateInviteRequest | undefined>({
    mutationFn: (input) => apiClient.groups.createInvite(groupId, input),
  });
}

/** 4.4 — revoke an invite (owner/admin). */
export function useRevokeInvite(groupId: string) {
  return useMutation({
    mutationFn: (inviteId: string) => apiClient.groups.revokeInvite(groupId, inviteId),
  });
}

/** 4.5 — redeem a code → join. Invalidates the list and seeds the joined detail. */
export function useJoinInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => apiClient.groups.joinInvite(code),
    onSuccess: (group) => {
      qc.setQueryData(groupKeys.detail(group.id), group);
      void qc.invalidateQueries({ queryKey: groupKeys.list() });
    },
  });
}
