/**
 * ProgressBar — determinate progress (upload, render poll). 0..1.
 */
import { View } from 'react-native';
import { useTheme } from '../theme';

export interface ProgressBarProps {
  /** 0..1 */
  value: number;
  height?: number;
  color?: string;
}

export function ProgressBar({ value, height = 8, color }: ProgressBarProps) {
  const theme = useTheme();
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 1, now: clamped }}
      style={{
        height,
        borderRadius: theme.radii.pill,
        backgroundColor: theme.colors.surface3,
        overflow: 'hidden',
        alignSelf: 'stretch',
      }}
    >
      <View
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          borderRadius: theme.radii.pill,
          backgroundColor: color ?? theme.colors.accent,
        }}
      />
    </View>
  );
}
