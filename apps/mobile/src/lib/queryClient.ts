// queryClient — the single react-query client for the app.
//
// Defaults tuned for a mobile app talking to a LAN/Tailscale API:
//   • retry: 1            — one retry on transient failures, then surface the error.
//   • staleTime: 30s      — avoid hammering the API on quick re-mounts / navigation.
//   • gcTime: 5m          — keep unused cache around briefly for back-navigation.
//   • refetchOnWindowFocus: false — there is no "window focus" on native; turning it
//     off keeps web behaviour consistent and prevents surprise refetches.
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
