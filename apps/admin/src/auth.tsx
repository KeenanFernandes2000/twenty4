// Admin auth context. Holds the bearer token + the signed-in admin's profile.
//
// Two ways in (alpha):
//   1. OTP — the SAME Better Auth email/phone OTP the mobile app uses
//      (/auth/start + /auth/verify). The resulting accessToken is stored.
//   2. Token paste — paste an accessToken directly (handy for the alpha / CI).
//
// After a token is present we call GET /users/me to confirm a live session and
// GET /admin/ops to confirm the principal is actually an admin (a non-admin → 403,
// which we surface as "not an admin"). Either check failing clears the token.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setToken, getToken, errMessage } from './api';
import { ApiError } from '@twenty4/api-client';
import type { MeResponse } from '@twenty4/contracts/dto';

interface AuthState {
  me: MeResponse | null;
  loading: boolean;
  /** Confirm the current token belongs to an admin; sets `me` or throws. */
  verifyAdmin: () => Promise<void>;
  /** Adopt a token (paste flow) then verify it's an admin. */
  signInWithToken: (token: string) => Promise<void>;
  /** Adopt a token from OTP verify, then verify admin. */
  adoptToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(!!getToken());

  const verifyAdmin = useCallback(async () => {
    // /users/me confirms a live session; /admin/ops confirms admin authority.
    const profile = await api.users.me();
    try {
      await api.admin.ops();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) {
        throw new Error('This account is not an admin.');
      }
      throw e;
    }
    setMe(profile);
  }, []);

  const adoptToken = useCallback(
    async (token: string) => {
      setToken(token);
      try {
        await verifyAdmin();
      } catch (e) {
        setToken(null);
        setMe(null);
        throw new Error(errMessage(e));
      }
    },
    [verifyAdmin],
  );

  const signInWithToken = adoptToken;

  const signOut = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* best-effort */
    }
    setToken(null);
    setMe(null);
  }, []);

  // On mount, if a token is already stored, try to restore the session.
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    (async () => {
      try {
        await verifyAdmin();
      } catch {
        setToken(null);
        if (!cancelled) setMe(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [verifyAdmin]);

  const value = useMemo<AuthState>(
    () => ({ me, loading, verifyAdmin, signInWithToken, adoptToken, signOut }),
    [me, loading, verifyAdmin, signInWithToken, adoptToken, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
