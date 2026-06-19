/**
 * Entry route. The root AuthGate (app/_layout.tsx) owns routing: it redirects
 * away from `index` to the (auth) stack when signed out, or the (main) tabs when
 * signed in. This screen is just a themed splash shown for the brief moment
 * before that redirect fires.
 */
import { View } from 'react-native';

import { useTheme } from '../theme';

export default function Index() {
  const theme = useTheme();
  return <View style={{ flex: 1, backgroundColor: theme.colors.bg }} />;
}
