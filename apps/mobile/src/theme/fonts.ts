/**
 * Font loading for twenty4 — Nunito (UI) + JetBrains Mono (mono).
 *
 * `useAppFonts()` gates first render in the root layout so text never flashes
 * with the system fallback. Backed by the @expo-google-fonts packages.
 */
import { useFonts } from 'expo-font';
import {
  Nunito_400Regular,
  Nunito_500Medium,
  Nunito_600SemiBold,
  Nunito_700Bold,
  Nunito_800ExtraBold,
} from '@expo-google-fonts/nunito';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';

/** Loads all app fonts; returns `true` once ready (or on load error). */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts({
    Nunito_400Regular,
    Nunito_500Medium,
    Nunito_600SemiBold,
    Nunito_700Bold,
    Nunito_800ExtraBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_700Bold,
  });

  // Don't block the app forever if a font fails to load.
  return loaded || error != null;
}
