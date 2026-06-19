/**
 * 5.1 Profile — the self profile + settings entry points.
 *
 * Slice 8 wires the two safety/account rows for real:
 *   - Blocked (5.5)        → profile/blocked
 *   - Delete account (5.6) → profile/delete-account (danger)
 * The remaining rows (Settings, Notifications) are Phase-2 stubs.
 */
import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { Screen } from '../../../components/Screen';
import { useTheme } from '../../../theme';
import { Avatar, Card, ListRow } from '../../../ui';
import { useMe } from '../../../lib/groups';

export default function Profile() {
  const theme = useTheme();
  const router = useRouter();
  const me = useMe().data;

  const displayName = me?.displayName ?? 'You';
  const handle = me?.username ? `@${me.username}` : 'Your profile';

  return (
    <Screen scroll>
      <Card style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        <Avatar name={displayName} uri={me?.profilePhotoUrl ?? undefined} size={72} />
        <Text style={{ ...theme.typography.heading, color: theme.colors.text }}>{displayName}</Text>
        <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>{handle}</Text>
      </Card>

      <Card padded={false}>
        <ListRow title="Settings" leadingIcon="settings-outline" showChevron onPress={() => {}} />
        <View style={{ height: 1, backgroundColor: theme.colors.border }} />
        <ListRow
          title="Notifications"
          leadingIcon="notifications-outline"
          showChevron
          onPress={() => {}}
        />
        <View style={{ height: 1, backgroundColor: theme.colors.border }} />
        <ListRow
          title="Blocked"
          subtitle="People you've blocked"
          leadingIcon="ban-outline"
          showChevron
          onPress={() => router.push('/(main)/profile/blocked')}
        />
      </Card>

      <Card padded={false}>
        <ListRow
          title="Delete account"
          subtitle="Permanently remove your account & content"
          leadingIcon="trash-outline"
          danger
          showChevron
          onPress={() => router.push('/(main)/profile/delete-account')}
        />
      </Card>
    </Screen>
  );
}
