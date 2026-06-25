import type { ReactNode } from 'react';
import {
  Pressable,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../theme';
import { Text, type TextColor } from './Text';
import { Spinner } from './Spinner';
import type { FontWeightName, TypeVariant } from '../theme/tokens';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends Omit<PressableProps, 'children' | 'style'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  leftIcon?: ReactNode;
  /** Button label. Either `title` or `children` (title wins if both given). */
  title?: string;
  children?: ReactNode;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}

const SIZES: Record<
  ButtonSize,
  { minHeight: number; paddingH: number; fontVariant: TypeVariant }
> = {
  sm: { minHeight: 38, paddingH: 16, fontVariant: 'body' },
  md: { minHeight: 46, paddingH: 20, fontVariant: 'body' },
  lg: { minHeight: 52, paddingH: 24, fontVariant: 'bodyLg' },
};

/** Per-variant text color, label font weight, and spinner tint. */
function variantText(variant: ButtonVariant): {
  color: TextColor;
  weight: FontWeightName;
} {
  switch (variant) {
    case 'primary':
      return { color: 'onAccent', weight: 'black' };
    case 'danger':
      return { color: 'danger', weight: 'black' };
    case 'secondary':
      return { color: 'primary', weight: 'extrabold' };
    case 'ghost':
      return { color: 'accent', weight: 'extrabold' };
  }
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  leftIcon,
  title,
  children,
  fullWidth = false,
  style,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const sz = SIZES[size];
  const isDisabled = disabled || loading;
  const label = title ?? children;
  const { color: textColor, weight } = variantText(variant);

  const spinnerColor =
    textColor === 'accent'
      ? theme.colors.accent
      : textColor === 'danger'
        ? theme.colors.danger
        : textColor === 'primary'
          ? theme.colors.textPrimary
          : theme.colors.onAccent;

  const base: ViewStyle = {
    minHeight: sz.minHeight,
    paddingHorizontal: sz.paddingH,
    borderRadius: theme.radii.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.md,
    alignSelf: fullWidth ? 'stretch' : 'flex-start',
    width: fullWidth ? '100%' : undefined,
  };

  const inner = loading ? (
    <Spinner size="small" color={spinnerColor} />
  ) : (
    <>
      {leftIcon != null ? <View>{leftIcon}</View> : null}
      {label != null ? (
        <Text variant={sz.fontVariant} weight={weight} color={textColor}>
          {label}
        </Text>
      ) : null}
    </>
  );

  // PRIMARY — ember gradient pill + glow (Pressable wraps the gradient so the
  // glow shadow + press transform apply to the outer rounded box).
  if (variant === 'primary') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled, busy: loading }}
        disabled={isDisabled}
        style={({ pressed }) => [
          theme.shadow('glow'),
          {
            alignSelf: base.alignSelf,
            width: base.width,
            borderRadius: base.borderRadius,
          },
          isDisabled ? styles.disabled : null,
          pressed && !isDisabled ? styles.pressed : null,
          style,
        ]}
        {...rest}
      >
        <LinearGradient
          colors={theme.accentGradient}
          start={theme.accentGradientStart}
          end={theme.accentGradientEnd}
          style={base}
        >
          {inner}
        </LinearGradient>
      </Pressable>
    );
  }

  // SECONDARY / GHOST / DANGER — flat surfaces.
  const variantStyle: ViewStyle =
    variant === 'secondary'
      ? {
          backgroundColor: theme.colors.surface,
          borderWidth: 1,
          borderColor: theme.colors.border,
        }
      : variant === 'danger'
        ? { backgroundColor: 'rgba(255,106,106,0.16)' }
        : { backgroundColor: 'transparent' }; // ghost

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        base,
        variantStyle,
        isDisabled ? styles.disabled : null,
        pressed && !isDisabled ? styles.pressed : null,
        style,
      ]}
      {...rest}
    >
      {inner}
    </Pressable>
  );
}

const styles = {
  pressed: { opacity: 0.85, transform: [{ scale: 0.985 }] } as ViewStyle,
  disabled: { opacity: 0.5 } as ViewStyle,
};
