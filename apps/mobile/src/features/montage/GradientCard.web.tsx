/**
 * GradientCard — WEB. react-native-web passes `backgroundImage` through to CSS,
 * so we render a true diagonal linear-gradient (matching the Spool prototype's
 * theme cards). Children render on top. The native variant approximates this
 * with layered fills.
 */
import { View, type ViewStyle } from 'react-native';
import type { GradientCardProps } from './GradientCard';

export function GradientCard({ from, to, style, children }: GradientCardProps) {
  return (
    <View
      // backgroundImage is a valid CSS prop on react-native-web.
      style={[{ backgroundImage: `linear-gradient(150deg, ${from}, ${to})` } as unknown as ViewStyle, style]}
    >
      {children}
    </View>
  );
}
