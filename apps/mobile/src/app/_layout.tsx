/**
 * Root layout — twenty4.
 *
 * Gates first render on fonts, then wraps the app in:
 *   GestureHandlerRootView → SafeAreaProvider → QueryClientProvider →
 *   ThemeProvider → AuthGate → Stack.
 *
 * AuthGate (Slice 3): hydrates the persisted session once, then redirects the
 * navigator on every segment change —
 *   - signed out            → (auth) stack (welcome 1.1)
 *   - signed in, needsProfile → (auth)/profile-setup (1.4)
 *   - signed in              → (main) tabs
 * The design-system /gallery route is left reachable in any state for review.
 */
import { useEffect } from 'react';
import { View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';

import { ThemeProvider, useAppFonts, useTheme } from '../theme';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/authStore';

/**
 * Drives navigation from auth state. Rendered inside the providers so it can
 * read the theme + store; renders the Stack as its children.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const router = useRouter();
  const segments = useSegments();

  const status = useAuthStore((s) => s.status);
  const needsProfile = useAuthStore((s) => s.needsProfile);
  const hydrate = useAuthStore((s) => s.hydrate);

  // Hydrate the persisted token exactly once on mount.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (status === 'loading') return;

    // `segments` is a typed tuple under typedRoutes; widen to string[] so we can
    // inspect nested segments without tuple-index errors.
    const parts = segments as string[];
    const root = parts[0];
    // Leave the design-system gallery reachable regardless of auth state.
    if (root === 'gallery') return;

    const inAuthGroup = root === '(auth)';
    // The invite deep-link route (`/invite/[code]`) redirects into the Groups
    // join screen once signed in; let signed-in users pass through so its
    // <Redirect> can carry the code. Signed-out users still get routed to auth.
    const onInviteLink = root === 'invite';

    if (status === 'signedOut') {
      if (!inAuthGroup) router.replace('/(auth)/welcome');
      return;
    }

    // signedIn
    if (needsProfile) {
      // Allow the profile-setup + its continuation screens (contacts /
      // notifications / legal) to stay put; otherwise force profile-setup.
      const profileFlow = ['profile-setup', 'contacts', 'notifications-priming', 'legal'];
      const onProfileFlow = inAuthGroup && profileFlow.includes(parts[1] ?? '');
      if (!onProfileFlow) router.replace('/(auth)/profile-setup');
      return;
    }

    // Signed in + on the invite deep-link: let its <Redirect> route into Groups.
    if (onInviteLink) return;

    if (inAuthGroup) router.replace('/(main)/today');
  }, [status, needsProfile, segments, router]);

  // Hold a blank themed canvas until we know where to send the user.
  if (status === 'loading') {
    return <View style={{ flex: 1, backgroundColor: theme.colors.bg }} />;
  }

  return <>{children}</>;
}

export default function RootLayout() {
  const fontsReady = useAppFonts();

  if (!fontsReady) {
    // Keep the splash up until fonts load to avoid a fallback-font flash.
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <StatusBar style="auto" />
            <AuthGate>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen
                  name="gallery"
                  options={{ headerShown: true, title: 'Design System' }}
                />
                <Stack.Screen name="(auth)" />
                <Stack.Screen name="(main)" />
                <Stack.Screen name="invite/[code]" />
              </Stack>
            </AuthGate>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
