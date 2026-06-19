/**
 * Groups stack — the Groups tab is itself a Stack so create/join/detail/members/
 * invite push as cards with their own headers (the tab bar persists). Header is
 * theme-driven; the index screen hides its own header chrome via options.
 */
import { Stack } from 'expo-router';

import { useTheme } from '../../../theme';

export default function GroupsStackLayout() {
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
      <Stack.Screen name="index" options={{ title: 'Groups' }} />
      <Stack.Screen name="create" options={{ title: 'New group', presentation: 'modal' }} />
      <Stack.Screen name="join" options={{ title: 'Join a group', presentation: 'modal' }} />
      <Stack.Screen name="[id]/index" options={{ title: 'Group' }} />
      <Stack.Screen name="[id]/members" options={{ title: 'Members' }} />
      <Stack.Screen name="[id]/invite" options={{ title: 'Invite', presentation: 'modal' }} />
    </Stack>
  );
}
