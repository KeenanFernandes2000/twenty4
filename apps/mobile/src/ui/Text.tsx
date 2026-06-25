import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { useTheme } from '../theme';
import type { TypeVariant, FontWeightName } from '../theme/tokens';

export type TextColor =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'label'
  | 'faint'
  | 'accent'
  | 'danger'
  | 'success'
  | 'onAccent';

export interface TextProps extends RNTextProps {
  variant?: TypeVariant;
  color?: TextColor;
  /** Override the font family/weight from the variant. */
  weight?: FontWeightName;
  align?: 'left' | 'center' | 'right';
  /** Force uppercase. `micro` is uppercase automatically. */
  uppercase?: boolean;
}

const COLOR_MAP: Record<TextColor, keyof ReturnType<typeof useTheme>['colors']> = {
  primary: 'textPrimary',
  secondary: 'textSecondary',
  muted: 'textMuted',
  label: 'textLabel',
  faint: 'textFaint',
  accent: 'accent',
  danger: 'danger',
  success: 'success',
  onAccent: 'onAccent',
};

export function Text({
  variant = 'body',
  color = 'primary',
  weight,
  align,
  uppercase,
  style,
  children,
  ...rest
}: TextProps) {
  const theme = useTheme();
  const t = theme.type[variant];
  const isUpper = uppercase ?? variant === 'micro';

  return (
    <RNText
      style={[
        {
          fontSize: t.fontSize,
          fontFamily: weight ? theme.fonts[weight] : t.fontFamily,
          letterSpacing: t.letterSpacing,
          lineHeight: t.lineHeight,
          color: theme.colors[COLOR_MAP[color]],
          ...(align ? { textAlign: align } : null),
          ...(isUpper ? { textTransform: 'uppercase' as const } : null),
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </RNText>
  );
}
