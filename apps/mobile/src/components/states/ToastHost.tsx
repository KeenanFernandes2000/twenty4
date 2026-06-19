/**
 * ToastHost — the single global toast surface (7.x Toasts).
 *
 * Mounted ONCE in the root layout (above the navigator). Subscribes to the toast
 * store and renders the active toast over everything, animated in/out. Anywhere in
 * the app fires via `toast.success(...)` / `useToastStore` — no per-screen wiring.
 *
 * Web-safe: reanimated + safe-area only; no native-only deps.
 */
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Toast } from '../../ui';
import { useToastStore } from '../../stores/toastStore';

export function ToastHost() {
  const insets = useSafeAreaInsets();
  const current = useToastStore((s) => s.current);
  const dismiss = useToastStore((s) => s.dismiss);

  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(current ? 1 : 0, { duration: 220 });
  }, [current, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * -12 }],
  }));

  if (!current) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: insets.top + 8,
        left: 16,
        right: 16,
        zIndex: 1000,
        elevation: 1000,
      }}
    >
      <Animated.View style={animatedStyle}>
        <Pressable accessibilityRole="alert" onPress={() => dismiss(current.id)}>
          <Toast message={current.message} tone={current.tone} />
        </Pressable>
      </Animated.View>
    </View>
  );
}
