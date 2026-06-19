/**
 * 7.5 Suspended — the global "account paused" gate.
 *
 * Shown by the root layout INSTEAD of the tabs whenever the api-client surfaces a
 * SuspendedError (403 `suspended`) → suspensionStore.suspended. The user keeps a
 * live token (a hard ban revokes sessions server-side → 401 → sign-out), but a
 * soft suspension blocks every read/write, so we present a calm dead-end:
 *   - "Account paused" + the community-guidelines copy.
 *   - "Contact support" (mailto) and a "Sign out" escape.
 *
 * Web-safe: uses Linking for the mailto; no native-only deps.
 */
import { Linking, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../../theme';
import { Button, Icon } from '../../ui';
import { useAuthStore } from '../../stores/authStore';
import { useSuspensionStore } from '../../stores/suspensionStore';

const SUPPORT_EMAIL = 'support@twenty4.app';

export function SuspendedScreen() {
  const theme = useTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();

  const reason = useSuspensionStore((s) => s.reason);
  const clearSuspension = useSuspensionStore((s) => s.clear);
  const signOut = useAuthStore((s) => s.signOut);

  const onSignOut = async () => {
    clearSuspension();
    await signOut();
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.bg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom + theme.spacing.lg,
        paddingHorizontal: theme.spacing.xl,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.lg,
      }}
    >
      <View
        style={{
          width: 88,
          height: 88,
          borderRadius: 44,
          backgroundColor: `${c.danger}1f`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="pause-circle-outline" size={48} color={c.danger} />
      </View>

      <Text style={{ ...theme.typography.title, color: c.text, textAlign: 'center' }}>
        Account paused
      </Text>

      <Text style={{ ...theme.typography.body, color: c.muted, textAlign: 'center' }}>
        {reason ??
          'Your account has been temporarily suspended for a community guidelines review. If you think this is a mistake, get in touch.'}
      </Text>

      <View style={{ alignSelf: 'stretch', gap: theme.spacing.sm, marginTop: theme.spacing.md }}>
        <Button
          label="Contact support"
          variant="primary"
          icon="mail-outline"
          fullWidth
          onPress={() =>
            void Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=Account%20review`)
          }
        />
        <Button label="Sign out" variant="ghost" fullWidth onPress={() => void onSignOut()} />
      </View>
    </View>
  );
}
