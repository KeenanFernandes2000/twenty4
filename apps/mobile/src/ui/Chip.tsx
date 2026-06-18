/**
 * Chip — small selectable pill (theme filters, reactions count, tags).
 */
import { Pressable, Text } from 'react-native';
import { useTheme } from '../theme';
import { Icon, type IconName } from './Icon';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
}

export function Chip({ label, selected = false, onPress, icon }: ChipProps) {
  const theme = useTheme();
  const fg = selected ? theme.colors.onAccent : theme.colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 7,
        paddingHorizontal: 12,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={fg} /> : null}
      <Text style={{ color: fg, fontFamily: theme.fontFamily.semibold, fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
}
