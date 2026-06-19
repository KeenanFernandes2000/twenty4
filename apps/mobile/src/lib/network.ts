/**
 * Network state (7.x Offline) — a single source of truth for connectivity.
 *
 * Wraps `expo-network`'s `addNetworkStateListener` / `getNetworkStateAsync` (which
 * work on native AND web — RN-web shims the browser's `navigator.onLine` +
 * online/offline events). `useIsOffline()` drives the global OfflineBanner and any
 * screen that wants to disable a network action while disconnected.
 *
 * Screenshot harness: a runtime global `globalThis.__TWENTY4_OFFLINE__ = true`
 * (set via Playwright `addInitScript` before app boot) FORCES the offline state so
 * the orchestrator can screenshot the banner deterministically without toggling
 * real connectivity. Default → the real listener.
 *
 * Web-safe: the listener is registered lazily; if expo-network throws on a
 * platform we degrade to "online" (never block the app on a connectivity probe).
 */
import { useEffect, useState } from 'react';

/** Forced-offline override for the web screenshot harness. */
function forcedOffline(): boolean {
  return (
    (globalThis as { __TWENTY4_OFFLINE__?: unknown }).__TWENTY4_OFFLINE__ === true ||
    process.env.EXPO_PUBLIC_FORCE_OFFLINE === '1'
  );
}

/**
 * `true` when the device has no usable connection. Connected-but-no-internet
 * (`isConnected && isInternetReachable === false`) also counts as offline so the
 * banner reflects "your requests won't work", not just radio state.
 */
export function useIsOffline(): boolean {
  const [offline, setOffline] = useState<boolean>(() => forcedOffline());

  useEffect(() => {
    if (forcedOffline()) {
      setOffline(true);
      return;
    }

    let sub: { remove: () => void } | undefined;
    let cancelled = false;

    const apply = (state: {
      isConnected?: boolean | null;
      isInternetReachable?: boolean | null;
    }) => {
      const connected = state.isConnected ?? true;
      const reachable = state.isInternetReachable;
      // Treat explicit unreachable as offline; `null`/undefined reachable is
      // "unknown" → trust `isConnected` so we don't flap a banner on cold start.
      setOffline(!connected || reachable === false);
    };

    (async () => {
      try {
        const Network = await import('expo-network');
        const initial = await Network.getNetworkStateAsync();
        if (!cancelled) apply(initial);
        sub = Network.addNetworkStateListener(apply);
      } catch {
        // expo-network unavailable on this platform → assume online.
        if (!cancelled) setOffline(false);
      }
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, []);

  return offline;
}
