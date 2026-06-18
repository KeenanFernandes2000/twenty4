import { Link } from 'expo-router';

import { Screen } from '../../../components/Screen';
import { useTheme } from '../../../theme';
import { Avatar, Button, Card, ListRow } from '../../../ui';
import { Text, View } from 'react-native';

export default function Profile() {
  const theme = useTheme();
  return (
    <Screen scroll>
      <Card style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        <Avatar name="You" size={72} />
        <Text style={{ ...theme.typography.heading, color: theme.colors.text }}>Your profile</Text>
        <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>Profile (5.1)</Text>
      </Card>
      <Card padded={false}>
        <ListRow title="Settings" leadingIcon="settings-outline" showChevron onPress={() => {}} />
        <View style={{ height: 1, backgroundColor: theme.colors.border }} />
        <ListRow title="Notifications" leadingIcon="notifications-outline" showChevron onPress={() => {}} />
        <View style={{ height: 1, backgroundColor: theme.colors.border }} />
        <ListRow title="Blocked" leadingIcon="ban-outline" showChevron onPress={() => {}} />
      </Card>
      <Link href="/gallery" asChild>
        <Button label="View design system" variant="secondary" icon="color-palette-outline" fullWidth />
      </Link>
    </Screen>
  );
}
