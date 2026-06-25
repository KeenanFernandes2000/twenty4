// secureStore (web) — localStorage backed session-token persistence.
// Used on web (Metro picks this over secureStore.native.ts by platform ext).
//
// Guarded for SSR / static web export: `localStorage` is undefined when there is
// no `window` (the export-time prerender, Node), so every access is wrapped in a
// typeof-window check + try/catch and degrades to a no-op / null. expo-secure-store
// is NEVER imported here — it has no web implementation.

export const SESSION_TOKEN_KEY = 'twenty4.session_token';

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export async function getToken(): Promise<string | null> {
  if (!hasStorage()) return null;
  try {
    return window.localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Quota / privacy-mode failures: tolerate — the in-memory token still works
    // for the session; we just can't persist across reloads.
  }
}

export async function deleteToken(): Promise<void> {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // ignore
  }
}
