import { QueryClient } from '@tanstack/react-query';

/** App-wide React Query client. Real query hooks land in later slices. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});
