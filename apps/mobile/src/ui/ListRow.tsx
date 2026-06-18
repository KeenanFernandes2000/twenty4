/**
 * ListRow — settings/list item with optional leading icon, subtitle, trailing.
 */
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { Icon, type IconName } from './Icon';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  leadingIcon?: IconName;
  trailing?: React.ReactNode;
  showChevron?: boolean;
  onPress?: () => void;
  danger?: boolean;
  style?: ViewStyle;
}

export function ListRow({
  title,
  subtitle,
  leadingIcon,
  trailing,
  showChevron = false,
  onPress,
  danger = false,
  style,
}: ListRowProps) {
  const theme = useTheme();
  const titleColor = danger ? theme.colors.danger : theme.colors.text;
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 14,
          paddingHorizontal: theme.spacing.lg,
          backgroundColor: pressed && onPress ? theme.colors.surface2 : 'transparent',
        },
        style,
      ]}
    >
      {leadingIcon ? (
        <Icon name={leadingIcon} size={20} color={danger ? theme.colors.danger : theme.colors.muted} />
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={{ color: titleColor, fontFamily: theme.fontFamily.semibold, fontSize: 15 }}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: theme.colors.muted, fontFamily: theme.fontFamily.regular, fontSize: 13 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {showChevron ? <Icon name="chevron-forward" size={18} color={theme.colors.faint} /> : null}
    </Pressable>
  );
}
