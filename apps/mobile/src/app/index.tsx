/**
 * Entry route. Slice-0 stub: no real auth, so we land on a simple hub that
 * links to the design-system gallery and the (main) tabs. Later slices replace
 * this with an auth-gated redirect (session → tabs, else → welcome).
 */
import { Link } from 'expo-router';
import { Text, View } from 'react-native';

import { Screen } from '../components/Screen';
import { useTheme } from '../theme';
import { Button, Card } from '../ui';

export default function Index() {
  const theme = useTheme();
  return (
    <Screen center>
      <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        <Text style={{ ...theme.typography.display, color: theme.colors.accent }}>twenty4</Text>
        <Text style={{ ...theme.typography.body, color: theme.colors.muted, textAlign: 'center' }}>
          Today’s moments. Gone in 24h.
        </Text>
      </View>
      <Card style={{ gap: theme.spacing.md, alignSelf: 'stretch' }}>
        <Link href="/gallery" asChild>
          <Button label="Design System Gallery" icon="color-palette-outline" fullWidth />
        </Link>
        <Link href="/(main)/today" asChild>
          <Button label="Enter app (tabs)" variant="secondary" icon="arrow-forward" fullWidth />
        </Link>
        <Link href="/(auth)/welcome" asChild>
          <Button label="Onboarding flow" variant="ghost" fullWidth />
        </Link>
      </Card>
    </Screen>
  );
}
