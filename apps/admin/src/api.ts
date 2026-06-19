// API wiring for the admin console. One shared @twenty4/api-client instance,
// reading the bearer token from localStorage so every admin call is authed.
import { createApiClient, ApiError } from '@twenty4/api-client';

const TOKEN_KEY = 'twenty4.admin.token';

export const API_URL =
  (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export const api = createApiClient({
  baseUrl: API_URL,
  getToken,
});

/** Human-readable message from any thrown error (ApiError-aware). */
export function errMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return `${e.message}${e.code ? ` (${e.code})` : ''}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export { ApiError };
