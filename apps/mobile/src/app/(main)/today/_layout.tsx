/**
 * Today stack — the daily capture loop (Slice 2).
 *
 * `index` (2.1) is the collected-media grid; `camera` (2.2) and `gallery` (2.3)
 * are pushed capture surfaces; `upload-progress` is the per-item upload tray.
 * The tab-level header (in (main)/_layout) is hidden for this group so each
 * screen owns its own header / forced-dark chrome.
 */
import { Stack } from 'expo-router';

import { useTheme } from '../../../theme';

export default function TodayLayout() {
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
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen
        name="camera"
        options={{ headerShown: false, presentation: 'fullScreenModal' }}
      />
      <Stack.Screen name="gallery" options={{ title: 'Add from library' }} />
      <Stack.Screen
        name="upload-progress"
        options={{ title: 'Uploads', presentation: 'modal' }}
      />
    </Stack>
  );
}
