import type { ReactNode } from 'react';
import {
  Pressable,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme';
import type { Theme } from '../theme/tokens';

export interface CardProps {
  children: ReactNode;
  /** Padding preset. `padded` (default) = spacing.xxl; `compact` = spacing.base. */
  variant?: 'padded' | 'compact';
  /** Radius token (default `xxl`). */
  radius?: keyof Theme['radii'];
  /** Render as a Pressable (row/list use). */
  onPress?: () => void;
  /** Add a hairline inner bezel ring on the elevated panel. */
  bezel?: boolean;
  /** Drop the neutral card shadow (default: shadow on). */
  flat?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Card({
  children,
  variant = 'padded',
  radius = 'xxl',
  onPress,
  bezel = false,
  flat = false,
  style,
}: CardProps) {
  const theme = useTheme();
  const pad = variant === 'compact' ? theme.spacing.base : theme.spacing.xxl;

  const containerStyle: ViewStyle = {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii[radius],
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: pad,
  };

  const bezelStyle: ViewStyle | null = bezel
    ? {
        borderWidth: 1,
        borderColor: theme.colors.bezel,
        borderRadius: theme.radii[radius],
      }
    : null;

  const shadowStyle = flat ? null : theme.shadow('card');

  // Bezel is a separate inset ring so it sits *inside* the border edge.
  const inner = bezel ? (
    <View
      pointerEvents="none"
      style={[
        bezelStyle,
        {
          position: 'absolute',
          top: 1,
          left: 1,
          right: 1,
          bottom: 1,
        },
      ]}
    />
  ) : null;

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        style={({ pressed }) => [
          containerStyle,
          shadowStyle,
          pressed ? styles.pressed : null,
          style,
        ]}
      >
        {inner}
        {children}
      </Pressable>
    );
  }

  return (
    <View style={[containerStyle, shadowStyle, style]}>
      {inner}
      {children}
    </View>
  );
}

const styles = {
  pressed: { opacity: 0.9 } as ViewStyle,
};
