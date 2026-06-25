// api — the single shared @twenty4/api-client instance for the whole app.
//
// One client, constructed once. `baseUrl` defaults to EXPO_PUBLIC_API_URL
// (set in root .env → http://100.98.100.117:3000). The client injects the bearer
// token on every authed request via `getToken`, and calls `onUnauthorized` on any
// 401 so the session can be cleared (the AuthGate then redirects to (auth)).
//
// ── Circular-import safety ───────────────────────────────────────────────────
// authStore imports THIS module (its async actions call `api.getMe()` etc.), and
// THIS module needs the store's token. If we read the store at module-eval time
// we'd create an import cycle that resolves to `undefined`. Instead:
//   • the store imports `api` lazily, INSIDE action bodies (deferred to call time),
//   • here we access the store ONLY inside the getToken/onUnauthorized closures,
//     which run long after both modules have finished evaluating.
// So module load order is irrelevant — by the time either closure fires, the
// store module is fully initialized.
import { createApiClient } from '@twenty4/api-client';
import { useAuthStore } from '@/stores/authStore';

// A missing EXPO_PUBLIC_API_URL no longer crashes construction — it surfaces as a
// request-time ApiError (code INTERNAL) on the first method call, so screens render.
export const api = createApiClient({
  // Synchronous read of the in-memory token (null when signed out). Deferred:
  // only invoked per-request, well after module init.
  getToken: () => useAuthStore.getState().token,
  // Called by the client on any 401 BEFORE it throws ApiError — clear the session
  // locally; the AuthGate observes status==='unauthenticated' and redirects.
  onUnauthorized: () => {
    void useAuthStore.getState().clear();
  },
});
