/**
 * Root layout — twenty4.
 *
 * Gates first render on fonts, then wraps the app in:
 *   GestureHandlerRootView → SafeAreaProvider → QueryClientProvider →
 *   ThemeProvider → Stack.
 *
 * Auth redirect is a Slice-0 stub (no real auth yet); the (auth)/(main) groups
 * exist so later slices wire `authStore.session` here.
 */
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';

import { ThemeProvider, useAppFonts } from '../theme';
import { queryClient } from '../lib/queryClient';

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
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="gallery" options={{ headerShown: true, title: 'Design System' }} />
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="(main)" />
            </Stack>
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
