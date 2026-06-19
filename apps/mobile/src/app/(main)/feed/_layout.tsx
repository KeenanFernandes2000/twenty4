/**
 * Feed stack — 3.1 index, 3.2 player (dark full-screen modal), 3.3 comments
 * (modal). The tab-level header (in (main)/_layout) renders the "Feed" title for
 * `index`; the player owns its own forced-dark chrome, and comments shows a
 * modal header. The other feed tabs keep the shared tab header.
 */
import { Stack } from 'expo-router';

import { useTheme } from '../../../theme';

export default function FeedLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTitleStyle: { color: theme.colors.text, fontFamily: theme.fontFamily.bold },
        headerTintColor: theme.colors.text,
        contentStyle: { backgroundColor: theme.colors.bg },
      }}
    >
      {/* 3.1 — the tab header (Feed) is provided by (main)/_layout; hide this one. */}
      <Stack.Screen name="index" options={{ headerShown: false }} />
      {/* 3.2 — dark full-screen modal player. */}
      <Stack.Screen
        name="player/[id]"
        options={{ headerShown: false, presentation: 'fullScreenModal', gestureEnabled: true }}
      />
      {/* 3.3 — comments modal. */}
      <Stack.Screen name="comments/[id]" options={{ title: 'Comments', presentation: 'modal' }} />
    </Stack>
  );
}
