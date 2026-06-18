import { Link, Stack } from 'expo-router';

import { Screen } from '../components/Screen';
import { useTheme } from '../theme';
import { Button, EmptyState } from '../ui';

export default function NotFound() {
  const theme = useTheme();
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Screen center>
        <EmptyState
          icon="help-circle-outline"
          title="This screen doesn’t exist"
          body="The link may be broken or the content has expired."
        />
        <Link href="/" asChild>
          <Button label="Go home" variant="secondary" />
        </Link>
      </Screen>
    </>
  );
}
