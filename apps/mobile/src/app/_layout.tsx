import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import {
  Nunito_400Regular,
  Nunito_600SemiBold,
  Nunito_700Bold,
  Nunito_800ExtraBold,
  Nunito_900Black,
} from '@expo-google-fonts/nunito';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/theme';
import { ToastProvider } from '@/ui';
import { queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/stores/authStore';
import { AuthGate } from '@/components/AuthGate';

// Keep the native splash up until our custom fonts have loaded, so the first
// frame never flashes a fallback system font.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Nunito_400Regular,
    Nunito_600SemiBold,
    Nunito_700Bold,
    Nunito_800ExtraBold,
    Nunito_900Black,
    JetBrainsMono_400Regular,
    JetBrainsMono_700Bold,
  });

  // Kick off session hydration ONCE on mount. authStore starts in 'loading'; the
  // AuthGate renders a Spinner until this resolves to a concrete status. Runs in
  // parallel with font loading; both must settle before the gate shows content.
  useEffect(() => {
    void useAuthStore.getState().hydrate();
  }, []);

  useEffect(() => {
    // Hide the splash once fonts resolve (or fail — don't hang the app on a
    // font network error).
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  // ThemeProvider + ToastProvider are ALREADY MOUNTED here (M5 / Ember design
  // system). QueryClientProvider wraps the whole tree; AuthGate wraps the <Stack>
  // (it reads auth status + route segments and redirects, and renders the
  // Spinner/SuspendedScreen states). Theme/Toast are NOT re-added. The Ember theme
  // flows via context (`useTheme()`); `useToast()` works anywhere under <Stack>.
  // expo-router already supplies SafeAreaProvider above this tree, and the
  // navigation context (so useSegments/useRouter work inside AuthGate here).
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <StatusBar style="light" />
          <AuthGate>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: '#161210' },
              }}
            />
          </AuthGate>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
