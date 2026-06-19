/**
 * (auth) onboarding stack — welcome 1.1 → sign-in 1.2 → verify 1.3 →
 * profile-setup 1.4 → contacts 1.5 → notifications-priming 1.6 → legal 1.7.
 *
 * Themed header (matches the (main) tab header); welcome owns a full-bleed
 * hero so it hides the header itself. Web-safe — no native-only imports.
 */
import { Stack } from 'expo-router';

import { useTheme } from '../../theme';

export default function AuthLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerBackTitle: 'Back',
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.colors.bg },
        headerTitleStyle: { color: theme.colors.text, fontFamily: theme.fontFamily.bold },
        headerTintColor: theme.colors.accent,
        contentStyle: { backgroundColor: theme.colors.bg },
      }}
    >
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
    </Stack>
  );
}
