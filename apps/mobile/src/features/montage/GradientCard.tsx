/**
 * GradientCard — NATIVE. A lightweight two-stop diagonal "gradient" without
 * pulling expo-linear-gradient into the bundle: a base fill (the `to` stop) with
 * a soft top-left overlay (the `from` stop). Good enough for the theme cards
 * (2.6); the web variant uses a real CSS gradient. Children render on top.
 */
import { View, type ViewStyle } from 'react-native';

export interface GradientCardProps {
  from: string;
  to: string;
  style?: ViewStyle;
  children?: React.ReactNode;
}

export function GradientCard({ from, to, style, children }: GradientCardProps) {
  return (
    <View style={[{ backgroundColor: to }, style]}>
      {/* Top-left wash toward `from`, fading to transparent. */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '70%',
          backgroundColor: from,
          opacity: 0.85,
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: to,
          opacity: 0.35,
        }}
      />
      {children}
    </View>
  );
}
