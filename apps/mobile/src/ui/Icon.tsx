/**
 * Icon wrapper around @expo/vector-icons (Ionicons). Theme-driven default color.
 */
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';

export type IconName = keyof typeof Ionicons.glyphMap;

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
}

export function Icon({ name, size = 20, color }: IconProps) {
  const theme = useTheme();
  return <Ionicons name={name} size={size} color={color ?? theme.colors.text} />;
}
