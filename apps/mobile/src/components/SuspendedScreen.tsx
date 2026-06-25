// SuspendedScreen — shown by the AuthGate (NOT a normal route) whenever
// status==='suspended', which covers accountStatus ∈ suspended | banned | deleted.
// It replaces the whole navigator output, so a restricted account can't reach any
// app screen. The only exit is sign-out (clears the session → back to welcome).
import { View } from 'react-native';
import { Screen, Text, Button } from '@/ui';
import { useTheme } from '@/theme';
import { useAuthStore } from '@/stores/authStore';

export function SuspendedScreen() {
  const theme = useTheme();
  return (
    <Screen>
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          gap: theme.spacing.lg,
          paddingVertical: theme.spacing.section,
        }}
      >
        <Text variant="h1">Account restricted</Text>
        <Text variant="body" color="muted">
          Your account is currently not active. If you think this is a mistake,
          please contact support.
        </Text>
        <View style={{ height: theme.spacing.lg }} />
        <Button
          variant="secondary"
          fullWidth
          title="Sign out"
          onPress={() => {
            void useAuthStore.getState().clear();
          }}
        />
      </View>
    </Screen>
  );
}
