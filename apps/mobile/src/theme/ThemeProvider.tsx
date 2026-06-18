/**
 * Theme context for twenty4.
 *
 * - `mode` is `system | light | dark`, persisted in expo-secure-store.
 * - Active tokens resolve via `mode` (or `useColorScheme()` when `system`).
 * - `useTheme()` returns the fully-typed active `Theme`.
 * - `ForcedDarkProvider` pins dark tokens for camera/player/reactions surfaces
 *   (prototype behavior) without touching the user's saved preference.
 *
 * No hardcoded colors live here — only token selection.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { darkTheme, lightTheme, type Theme } from './tokens';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'twenty4.themeMode';

interface ThemeContextValue {
  /** The resolved, active theme. */
  theme: Theme;
  /** The user's chosen mode (may be `system`). */
  mode: ThemeMode;
  /** Persist a new mode. */
  setMode: (mode: ThemeMode) => void;
  /** Convenience: cycle system → light → dark → system. */
  toggle: () => void;
  /** Whether the active theme is dark. */
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveTheme(mode: ThemeMode, systemScheme: 'light' | 'dark'): Theme {
  const scheme = mode === 'system' ? systemScheme : mode;
  return scheme === 'dark' ? darkTheme : lightTheme;
}

export function ThemeProvider({
  children,
  initialMode = 'system',
}: {
  children: ReactNode;
  initialMode?: ThemeMode;
}) {
  const system = useColorScheme() ?? 'light';
  const [mode, setModeState] = useState<ThemeMode>(initialMode);

  // Hydrate persisted preference once.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const saved = await SecureStore.getItemAsync(STORAGE_KEY);
        if (active && (saved === 'light' || saved === 'dark' || saved === 'system')) {
          setModeState(saved);
        }
      } catch {
        // SecureStore unavailable (e.g. web export) — fall back to default.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    void SecureStore.setItemAsync(STORAGE_KEY, next).catch(() => {
      // Persistence is best-effort; ignore on unsupported platforms.
    });
  }, []);

  const toggle = useCallback(() => {
    setMode(mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system');
  }, [mode, setMode]);

  const theme = resolveTheme(mode, system === 'dark' ? 'dark' : 'light');

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, mode, setMode, toggle, isDark: theme.scheme === 'dark' }),
    [theme, mode, setMode, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Forces the dark palette for the subtree (camera / player / reactions),
 * matching the Ember prototype. Does not persist or override user preference.
 */
export function ForcedDarkProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: darkTheme,
      mode: 'dark',
      setMode: () => undefined,
      toggle: () => undefined,
      isDark: true,
    }),
    [],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx.theme;
}

export function useThemeControls(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useThemeControls must be used within a ThemeProvider');
  }
  return ctx;
}
