/**
 * PrimingHero — centered icon badge + title + subtitle, shared by the
 * permission-priming screens (contacts 1.5, notifications 1.6).
 */
import { Text, View } from 'react-native';

import { useTheme } from '../theme';
import { Icon, type IconName } from '../ui';

export function PrimingHero({
  icon,
  title,
  subtitle,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
}) {
  const theme = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.md, marginTop: theme.spacing.xl }}>
      <View
        style={{
          width: 96,
          height: 96,
          borderRadius: theme.radii['2xl'],
          backgroundColor: theme.colors.accentSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={48} color={theme.colors.accent} />
      </View>
      <Text style={{ ...theme.typography.title, color: theme.colors.text, textAlign: 'center' }}>
        {title}
      </Text>
      <Text
        style={{
          ...theme.typography.body,
          color: theme.colors.muted,
          textAlign: 'center',
          paddingHorizontal: theme.spacing.md,
        }}
      >
        {subtitle}
      </Text>
    </View>
  );
}
