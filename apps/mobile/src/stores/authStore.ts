/**
 * authStore — the single source of truth for the session token (zustand).
 *
 * - The bearer `token` is persisted in `expo-secure-store` (key `SESSION_KEY`).
 *   On web export SecureStore is unavailable; we degrade gracefully (in-memory
 *   only) so the auth screens still render and export.
 * - `status` drives the root auth gate: `loading` until we've tried to hydrate
 *   the persisted token, then `signedIn` / `signedOut`.
 * - `needsProfile` is set from the verify response so the gate can route a fresh
 *   sign-in to profile-setup (1.4) before the (main) tabs.
 *
 * The api client reads `getToken()` synchronously off this store, and the query
 * client calls `signOut()` on any 401 (see lib/queryClient.ts + lib/apiClient.ts).
 */
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import type { SessionTokens } from '@twenty4/contracts/dto';

const SESSION_KEY = 'twenty4.session.token';
const REFRESH_KEY = 'twenty4.session.refresh';

export type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

interface AuthState {
  status: AuthStatus;
  token: string | null;
  refreshToken: string | null;
  /** True after a fresh sign-in with no profile yet → route to profile-setup. */
  needsProfile: boolean;
  /** Read the bearer token synchronously (consumed by the api client). */
  getToken: () => string | null;
  /** Hydrate the persisted token once on app start. */
  hydrate: () => Promise<void>;
  /** Persist a verified session and flip the gate to signedIn. */
  signIn: (tokens: SessionTokens) => Promise<void>;
  /** Mark the profile step done so the gate stops routing to profile-setup. */
  markProfileComplete: () => void;
  /** Clear the session (logout / 401) and flip the gate to signedOut. */
  signOut: () => Promise<void>;
}

/** Best-effort SecureStore write (no-op where unavailable, e.g. web export). */
async function persist(key: string, value: string | null): Promise<void> {
  try {
    if (value === null) {
      await SecureStore.deleteItemAsync(key);
    } else {
      await SecureStore.setItemAsync(key, value);
    }
  } catch {
    // SecureStore unavailable (web) — token lives in memory for this session.
  }
}

async function read(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  token: null,
  refreshToken: null,
  needsProfile: false,

  getToken: () => get().token,

  hydrate: async () => {
    const [token, refreshToken] = await Promise.all([read(SESSION_KEY), read(REFRESH_KEY)]);
    set({
      token: token ?? null,
      refreshToken: refreshToken ?? null,
      status: token ? 'signedIn' : 'signedOut',
    });
  },

  signIn: async (tokens) => {
    await Promise.all([
      persist(SESSION_KEY, tokens.accessToken),
      persist(REFRESH_KEY, tokens.refreshToken),
    ]);
    set({
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      needsProfile: tokens.needsProfile ?? false,
      status: 'signedIn',
    });
  },

  markProfileComplete: () => set({ needsProfile: false }),

  signOut: async () => {
    await Promise.all([persist(SESSION_KEY, null), persist(REFRESH_KEY, null)]);
    set({ token: null, refreshToken: null, needsProfile: false, status: 'signedOut' });
  },
}));
