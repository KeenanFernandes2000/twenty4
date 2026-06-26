// authStore — the single source of truth for session + auth status (zustand).
//
// The store holds the in-memory bearer token (mirrored durably in secureStore),
// the hydrated user, and a DERIVED `status` the AuthGate routes on. Screen agents
// drive auth purely through the actions below — they never touch secureStore or
// the api-client's token directly.
//
// ── Status state machine ─────────────────────────────────────────────────────
//   loading          initial / hydrating. AuthGate shows a full-screen Spinner.
//   unauthenticated  no token, OR a real 401 (token rejected). → (auth)/welcome.
//   needs-profile    valid token, accountStatus==='active', but displayName or
//                    username is null (new user post-verify). → (auth)/profile-setup.
//   suspended        valid token but accountStatus !== 'active'
//                    (suspended | banned | deleted). → SuspendedScreen (global).
//   authenticated    valid token, active account, profile complete. → (app).
//
// Transitions:
//   hydrate():     loading → (no token) unauthenticated
//                          → (token + getMe ok) derive(user)
//                          → (token + 401)      unauthenticated  (token wiped)
//                          → (token + network)  unauthenticated  (token KEPT — see below)
//   setSession(t): persist t, token set, then refreshMe() → derive(user)
//   refreshMe():   getMe() → derive(user); on 401 → clear(); on network → unauthenticated (token KEPT)
//   clear():       wipe token (memory + disk), best-effort authLogout → unauthenticated
//
// ── Network-failure policy ───────────────────────────────────────────────────
// We distinguish "the server REJECTED the token (401)" from "we couldn't REACH the
// server (network error)". A 401 is authoritative: the token is invalid → wipe it
// and go unauthenticated. A network error is NOT authoritative — the token may
// still be perfectly valid — so we KEEP the persisted token (don't punish the user
// for being offline) but report `unauthenticated` for routing this session, so the
// user lands on welcome and can retry. On the next successful hydrate the kept
// token re-authenticates them. (We deliberately don't add a separate 'offline'
// status to keep the gate simple; the kept token is what makes this recoverable.)
import { create } from 'zustand';
import { ApiError } from '@twenty4/api-client';
import type { UserDTO } from '@twenty4/contracts';
import { getToken, setToken, deleteToken } from '@/lib/secureStore';
import { queryClient } from '@/lib/queryClient';

export type AuthStatus =
  | 'loading'
  | 'unauthenticated'
  | 'authenticated'
  | 'suspended'
  | 'needs-profile';

export interface AuthState {
  token: string | null;
  user: UserDTO | null;
  status: AuthStatus;
  // Actions
  hydrate: () => Promise<void>;
  setSession: (token: string) => Promise<void>;
  refreshMe: () => Promise<void>;
  clear: () => Promise<void>;
}

/**
 * Derive the routing status from a hydrated user. A user object means the token
 * was accepted by the API; we only have to classify account state + profile
 * completeness here.
 */
function deriveStatus(user: UserDTO): AuthStatus {
  if (user.accountStatus !== 'active') return 'suspended';
  if (user.displayName == null || user.username == null) return 'needs-profile';
  return 'authenticated';
}

/**
 * Was this thrown error an authoritative 401 from the API (token rejected),
 * vs. a network/transport failure (server unreachable)? Only a 401 should wipe
 * the session.
 */
function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * The API's per-request account-status gate returns 403 (NOT a user object) for a
 * valid token on a non-active account — even on GET /users/me. So getMe() THROWS an
 * ApiError on a suspended/banned/deleted account rather than returning a UserDTO with
 * accountStatus !== 'active'; deriveStatus() never sees those. We must classify the
 * thrown error here:
 *   ACCOUNT_SUSPENDED | ACCOUNT_BANNED → 'suspended'  (→ SuspendedScreen; keep token
 *                                                       so the in-screen sign-out can
 *                                                       still call authLogout)
 *   ACCOUNT_DELETED                    → 'deleted'    (caller clears → unauthenticated)
 * Returns null for any other error (let the 401 / network policy handle it).
 */
function accountStatusFromError(err: unknown): 'suspended' | 'deleted' | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case 'ACCOUNT_SUSPENDED':
    case 'ACCOUNT_BANNED':
      return 'suspended';
    case 'ACCOUNT_DELETED':
      return 'deleted';
    default:
      return null;
  }
}

// Lazy `api` import: importing at module top would form a cycle
// (api.ts imports this store). Deferred to call time, both modules are ready.
async function getApi() {
  const mod = await import('@/lib/api');
  return mod.api;
}

// Lazy montage-store clear: montageStore imports `api` and api.ts imports THIS
// store, so a top-level import here would form a cycle (authStore → montageStore →
// api → authStore). Deferred to call time (mirrors getApi). Drops any in-flight
// montage (current/error) so it never leaks across an account switch / logout.
async function clearMontageStore() {
  const { useMontageStore } = await import('@/stores/montageStore');
  useMontageStore.getState().clear();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  status: 'loading',

  hydrate: async () => {
    const stored = await getToken();
    if (!stored) {
      set({ token: null, user: null, status: 'unauthenticated' });
      return;
    }
    // Token present — set it in memory so the api-client's getToken sees it, then
    // validate by hydrating the user.
    set({ token: stored });
    try {
      const api = await getApi();
      const user = await api.getMe();
      set({ user, status: deriveStatus(user) });
    } catch (err) {
      const acct = accountStatusFromError(err);
      if (acct === 'suspended') {
        // Valid token, restricted account (403) — pin to SuspendedScreen. KEEP the
        // token so the in-screen sign-out can authLogout server-side.
        set({ user: null, status: 'suspended' });
      } else if (acct === 'deleted') {
        // Account is gone — wipe the session and send to welcome.
        await get().clear();
      } else if (isUnauthorized(err)) {
        // Token rejected — wipe it.
        await deleteToken();
        set({ token: null, user: null, status: 'unauthenticated' });
      } else {
        // Network / transport error — KEEP the persisted token (it may be valid),
        // but route to unauthenticated this session so the user can retry.
        set({ user: null, status: 'unauthenticated' });
      }
    }
  },

  setSession: async (token: string) => {
    // Belt-and-suspenders for account switches that DON'T go through an explicit
    // logout (e.g. a token replaced directly): drop all cached queries so the
    // incoming user never sees the previous user's data. Query keys are static
    // (not userId-scoped) today; clearing the cache is the surgical fix.
    // (Future hardening: scope query keys by userId to avoid the blanket clear.)
    queryClient.clear();
    // Drop any in-flight montage too — it's not in the query cache (zustand).
    await clearMontageStore();
    await setToken(token);
    set({ token });
    await get().refreshMe();
  },

  refreshMe: async () => {
    try {
      const api = await getApi();
      const user = await api.getMe();
      set({ user, status: deriveStatus(user) });
    } catch (err) {
      const acct = accountStatusFromError(err);
      if (acct === 'suspended') {
        // Restricted account (403) — pin to SuspendedScreen (token kept for logout).
        set({ user: null, status: 'suspended' });
      } else if (acct === 'deleted') {
        await get().clear();
      } else if (isUnauthorized(err)) {
        await get().clear();
      } else {
        // Network error: keep token, surface unauthenticated for routing/retry.
        set({ status: 'unauthenticated' });
      }
    }
  },

  clear: async () => {
    // Guard against re-entry: authLogout()'s own 401 → onUnauthorized → clear()
    // again. Only call the server logout when a token is actually present (skip it
    // once it's already null), so the second pass clears locally without re-hitting
    // the network. We wipe the in-memory token FIRST so the re-entrant call sees null.
    const hadToken = get().token != null;
    set({ token: null });
    if (hadToken) {
      // Best-effort server-side logout; tolerate any failure (offline, already gone).
      try {
        const api = await getApi();
        await api.authLogout();
      } catch {
        // ignore — we clear locally regardless.
      }
    }
    await deleteToken();
    // Drop ALL cached react-query data so the next user mounts fresh. Without this,
    // logging out of A and into B briefly serves A's cached groups/me (the query
    // keys are static, not userId-scoped), until a manual refetch.
    queryClient.clear();
    // Same for the montage store (zustand, not in the query cache).
    await clearMontageStore();
    set({ token: null, user: null, status: 'unauthenticated' });
  },
}));

// ── Convenience selectors ────────────────────────────────────────────────────
// Use these to subscribe to a single slice (re-renders only when it changes):
//   const status = useAuthStatus();
//   const user = useAuthUser();
export const useAuthStatus = () => useAuthStore((s) => s.status);
export const useAuthUser = () => useAuthStore((s) => s.user);
