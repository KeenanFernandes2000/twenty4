// (app) group layout — post-session flow (requires an authenticated session; the
// AuthGate enforces that). A themed Stack, headers hidden. The group-screens agent
// extends this with the Groups home, group detail, etc.
import { Stack } from 'expo-router';
import { useTheme } from '@/theme';
import { ConfirmProvider } from '@/components/ConfirmProvider';

export default function AppLayout() {
  const theme = useTheme();
  return (
    // ConfirmProvider mounts the single themed destructive-confirm dialog once for
    // the whole authed app, so every screen's `confirm()` drives it (M9 polish).
    <ConfirmProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.bg },
        }}
      />
    </ConfirmProvider>
  );
}
