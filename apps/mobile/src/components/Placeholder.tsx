/**
 * Placeholder — Slice-0 stub screen body. Renders the screen name + an
 * EmptyState. Real screens land in later slices.
 */
import { Text } from 'react-native';

import { Screen } from './Screen';
import { useTheme } from '../theme';
import { EmptyState, type IconName } from '../ui';

export interface PlaceholderProps {
  name: string;
  description?: string;
  icon?: IconName;
}

export function Placeholder({
  name,
  description = 'Coming in a later slice.',
  icon = 'construct-outline',
}: PlaceholderProps) {
  const theme = useTheme();
  return (
    <Screen scroll center>
      <Text style={{ ...theme.typography.heading, color: theme.colors.text, textAlign: 'center' }}>
        {name}
      </Text>
      <EmptyState icon={icon} title={name} body={description} />
    </Screen>
  );
}
