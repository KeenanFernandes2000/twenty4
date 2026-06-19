/**
 * App-wide React Query client.
 *
 * Global error handling:
 *   - `UnauthorizedError` (401) → the session is dead. Clear it and let the root
 *     gate route back to the (auth) stack.
 *   - `SuspendedError` (403 `suspended`) → the account is paused/banned. Flip the
 *     global suspension flag; the root layout renders the 7.5 Suspended screen
 *     instead of the tabs (lib/../stores/suspensionStore).
 */
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { SuspendedError, UnauthorizedError } from '@twenty4/api-client';

import { useAuthStore } from '../stores/authStore';
import { useSuspensionStore } from '../stores/suspensionStore';

function handleGlobalError(error: unknown): void {
  if (error instanceof UnauthorizedError) {
    void useAuthStore.getState().signOut();
    return;
  }
  if (error instanceof SuspendedError) {
    useSuspensionStore.getState().setSuspended(error.message);
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleGlobalError }),
  mutationCache: new MutationCache({ onError: handleGlobalError }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Never retry auth / suspension failures; retry transient errors once.
        if (error instanceof UnauthorizedError) return false;
        if (error instanceof SuspendedError) return false;
        return failureCount < 1;
      },
      staleTime: 30_000,
    },
  },
});
