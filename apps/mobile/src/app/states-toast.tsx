/**
 * /states-toast — a dev/screenshot-only route that fires a GLOBAL toast on mount
 * so the 7.x "Toasts" surface (the single ToastHost in the root layout) can be
 * demonstrated/screenshotted deterministically. The tone is read from `?tone=`
 * (info | success | error) so all three can be captured. Not linked from any UI;
 * reachable only by navigating to /states-toast directly. Harmless in production.
 */
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';

import { useTheme } from '../theme';
import { toast } from '../stores/toastStore';
import type { ToastTone } from '../ui';

const MESSAGES: Record<ToastTone, string> = {
  info: 'Heads up — your recap is generating.',
  success: 'Recap published to your groups.',
  error: 'Couldn’t publish — check your connection.',
};

export default function StatesToast() {
  const theme = useTheme();
  const { tone } = useLocalSearchParams<{ tone?: string }>();
  const t: ToastTone =
    tone === 'success' || tone === 'error' || tone === 'info' ? tone : 'success';

  useEffect(() => {
    // Long duration so the screenshot harness reliably captures it.
    toast.show(MESSAGES[t], t, 60_000);
  }, [t]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
          padding: theme.spacing.xl,
        }}
      >
        <Text style={{ ...theme.typography.body, color: theme.colors.muted, textAlign: 'center' }}>
          Global toast demo — the toast is rendered by the single ToastHost in the
          root layout, above this screen.
        </Text>
      </View>
    </>
  );
}
