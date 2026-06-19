/**
 * apiClient — the app-wide `@twenty4/api-client` instance.
 *
 * - `baseUrl` comes from `EXPO_PUBLIC_API_URL` (set per environment); falls back
 *   to the local dev API on :4000.
 * - `getToken` reads the bearer token synchronously off the zustand authStore,
 *   so every request is authenticated once a session exists.
 * - 401 handling: the client itself throws `UnauthorizedError`; the query client
 *   (lib/queryClient.ts) catches it globally and calls `authStore.signOut()`,
 *   which flips the root gate back to the (auth) stack. We expose `apiCall` as a
 *   thin wrapper that mutations use directly.
 */
import { createApiClient } from '@twenty4/api-client';

import { useAuthStore } from '../stores/authStore';

const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';

export const apiClient = createApiClient({
  baseUrl,
  getToken: () => useAuthStore.getState().getToken(),
});

export type AppApiClient = typeof apiClient;
