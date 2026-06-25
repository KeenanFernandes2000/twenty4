// AuthSegmentedControl — a small two-up segmented toggle for the sign-in channel
// (phone | email). AUTH-SCOPED ON PURPOSE: this is a focused inline control, not a
// shared generic component (the groups agent owns generic primitives). Built from
// Pressables + theme tokens, ember-styled. Generic over the option value so it
// stays typed (no `any`).
import { Pressable, View, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';
import { Text } from '@/ui';

export interface AuthSegmentOption<T extends string> {
  value: T;
  label: string;
  /** testID applied to the option's Pressable (for the test agent). */
  testID?: string;
}

export interface AuthSegmentedControlProps<T extends string> {
  options: readonly AuthSegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

export function AuthSegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: AuthSegmentedControlProps<T>) {
  const theme = useTheme();

  const track: ViewStyle = {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.xs,
    gap: theme.spacing.xs,
  };

  return (
    <View style={track} accessibilityRole="tablist">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            testID={opt.testID}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(opt.value)}
            style={{
              flex: 1,
              minHeight: 40,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: theme.radii.pill,
              backgroundColor: selected ? theme.colors.accentSoft : 'transparent',
              borderWidth: 1,
              borderColor: selected ? theme.colors.accent : 'transparent',
            }}
          >
            <Text
              variant="body"
              weight={selected ? 'black' : 'bold'}
              color={selected ? 'accent' : 'muted'}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
