/**
 * App-wide React Query client.
 *
 * Global error handling: any `UnauthorizedError` (401) bubbling out of a query
 * or mutation means the session is dead → clear it and let the root gate route
 * back to the (auth) stack. `SuspendedError` (403 `suspended`) is left for the
 * 7.5 suspended gate in a later slice.
 */
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { UnauthorizedError } from '@twenty4/api-client';

import { useAuthStore } from '../stores/authStore';

function handleGlobalError(error: unknown): void {
  if (error instanceof UnauthorizedError) {
    void useAuthStore.getState().signOut();
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleGlobalError }),
  mutationCache: new MutationCache({ onError: handleGlobalError }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Never retry auth failures; retry transient errors once.
        if (error instanceof UnauthorizedError) return false;
        return failureCount < 1;
      },
      staleTime: 30_000,
    },
  },
});
