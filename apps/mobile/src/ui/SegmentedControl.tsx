/**
 * SegmentedControl — single-select horizontal segments (theme/tab switches).
 */
import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';

export interface SegmentedControlProps<T extends string> {
  options: readonly { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        padding: 3,
        borderRadius: theme.radii.lg,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignSelf: 'stretch',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(opt.value)}
            style={{
              flex: 1,
              paddingVertical: 9,
              borderRadius: theme.radii.md,
              backgroundColor: active ? theme.colors.surface : 'transparent',
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                color: active ? theme.colors.text : theme.colors.muted,
                fontFamily: active ? theme.fontFamily.bold : theme.fontFamily.medium,
                fontSize: 14,
              }}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
