import { createContext, useContext, type ReactNode } from 'react';
import { theme as defaultTheme, type Theme } from './tokens';

/**
 * Single dark theme today, but the theme flows through context (not bare module
 * imports) so a future light/alt theme can be swapped without touching consumers.
 */
const ThemeContext = createContext<Theme>(defaultTheme);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Override the theme object (future theming / tests). Defaults to Ember dark. */
  value?: Theme;
}

export function ThemeProvider({ children, value }: ThemeProviderProps) {
  return (
    <ThemeContext.Provider value={value ?? defaultTheme}>
      {children}
    </ThemeContext.Provider>
  );
}

/** Access the active theme. Safe without a provider (falls back to Ember dark). */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
