// (app) group layout — post-session flow (requires an authenticated session; the
// AuthGate enforces that). A themed Stack, headers hidden. The group-screens agent
// extends this with the Groups home, group detail, etc.
import { Stack } from 'expo-router';
import { useTheme } from '@/theme';

export default function AppLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.bg },
      }}
    />
  );
}
