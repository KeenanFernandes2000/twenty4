/**
 * Profile stack — the Profile tab is itself a Stack so Blocked (5.5) and Delete
 * account (5.6) push as cards with their own back headers (the tab bar persists).
 * Header is theme-driven; the index screen titles itself "Profile".
 */
import { Stack } from 'expo-router';

import { useTheme } from '../../../theme';

export default function ProfileStackLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTitleStyle: { color: theme.colors.text, fontFamily: theme.fontFamily.bold },
        headerTintColor: theme.colors.accent,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Profile' }} />
      <Stack.Screen name="blocked" options={{ title: 'Blocked' }} />
      <Stack.Screen name="delete-account" options={{ title: 'Delete account' }} />
    </Stack>
  );
}
