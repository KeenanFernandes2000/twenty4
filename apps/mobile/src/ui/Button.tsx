/**
 * Button — Ember primitive. Variants: primary | secondary | ghost | danger.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '../theme';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  icon?: IconName;
  fullWidth?: boolean;
}

function colorsFor(theme: Theme, variant: ButtonVariant) {
  const c = theme.colors;
  switch (variant) {
    case 'primary':
      return { bg: c.accent, fg: c.onAccent, border: 'transparent' };
    case 'danger':
      return { bg: c.danger, fg: c.onAccent, border: 'transparent' };
    case 'secondary':
      return { bg: c.surface2, fg: c.text, border: c.border };
    case 'ghost':
      return { bg: 'transparent', fg: c.accent, border: 'transparent' };
  }
}

const SIZES: Record<ButtonSize, { padV: number; padH: number; font: number; icon: number }> = {
  sm: { padV: 8, padH: 12, font: 14, icon: 16 },
  md: { padV: 12, padH: 16, font: 15, icon: 18 },
  lg: { padV: 15, padH: 20, font: 17, icon: 20 },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  fullWidth = false,
}: ButtonProps) {
  const theme = useTheme();
  const tone = colorsFor(theme, variant);
  const dim = SIZES[size];
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: tone.bg,
          borderColor: tone.border,
          borderRadius: theme.radii.md,
          paddingVertical: dim.padV,
          paddingHorizontal: dim.padH,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator size="small" color={tone.fg} />
        ) : (
          <>
            {icon ? <Icon name={icon} size={dim.icon} color={tone.fg} /> : null}
            <Text
              style={{
                color: tone.fg,
                fontFamily: theme.fontFamily.bold,
                fontSize: dim.font,
              }}
            >
              {label}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
