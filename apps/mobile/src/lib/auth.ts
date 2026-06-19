/**
 * Auth data layer — React Query mutations over the api-client auth/users
 * methods, wired to the zustand authStore.
 *
 * Each screen consumes one hook and reads `{ mutate, isPending, error }` for
 * loading/error states rendered with the Ember primitives.
 */
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@twenty4/api-client';
import type {
  AuthStartRequest,
  AuthVerifyRequest,
  UpdateUserRequest,
} from '@twenty4/contracts/dto';

import { apiClient } from './apiClient';
import { useAuthStore } from '../stores/authStore';

/** Friendly message for any error surfaced to the user. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

/**
 * 1.2 — POST /auth/start. Begins an email/phone OTP (returns a challengeId) or
 * enters a social flow (apple/google stub).
 */
export function useAuthStart() {
  return useMutation({
    mutationFn: (input: AuthStartRequest) => apiClient.auth.start(input),
  });
}

/**
 * 1.3 — POST /auth/verify. On success the session tokens are persisted via
 * `authStore.signIn`, flipping the root gate (and setting `needsProfile`).
 */
export function useAuthVerify() {
  const signIn = useAuthStore((s) => s.signIn);
  return useMutation({
    mutationFn: (input: AuthVerifyRequest) => apiClient.auth.verify(input),
    onSuccess: async (tokens) => {
      await signIn(tokens);
    },
  });
}

/**
 * 1.4 — PATCH /users/me (display_name + username citext-unique + photo).
 * On success we clear `needsProfile` so the gate advances past profile-setup.
 */
export function useUpdateProfile() {
  const markProfileComplete = useAuthStore((s) => s.markProfileComplete);
  return useMutation({
    mutationFn: (input: UpdateUserRequest) => apiClient.users.updateMe(input),
    onSuccess: () => {
      markProfileComplete();
    },
  });
}

/** Logout — revoke the current session, then clear local auth regardless. */
export function useLogout() {
  const signOut = useAuthStore((s) => s.signOut);
  return useMutation({
    mutationFn: async () => {
      try {
        await apiClient.auth.logout();
      } catch {
        // Best-effort server revoke; always clear local session below.
      }
    },
    onSettled: async () => {
      await signOut();
    },
  });
}
