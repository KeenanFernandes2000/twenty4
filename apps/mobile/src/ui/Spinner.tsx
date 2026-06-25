import { ActivityIndicator, type ColorValue } from 'react-native';
import { useTheme } from '../theme';

export interface SpinnerProps {
  size?: 'small' | 'large' | number;
  /** Override color (defaults to ember accent). */
  color?: ColorValue;
}

export function Spinner({ size = 'small', color }: SpinnerProps) {
  const theme = useTheme();
  return <ActivityIndicator size={size} color={color ?? theme.colors.accent} />;
}
