/**
 * OfflineBanner — the global 7.x "Offline" indicator.
 *
 * Mounted ONCE in the root layout (under the navigator, above content). Reads the
 * shared network state (lib/network) and slides a thin themed bar down from the
 * top whenever the device is disconnected (or connected-but-no-internet). Hidden
 * the moment connectivity returns. Strictly themed; no raw colors.
 *
 * Web-safe: reanimated + safe-area only.
 */
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '../../theme';
import { Icon } from '../../ui';
import { useIsOffline } from '../../lib/network';

export function OfflineBanner() {
  const theme = useTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const offline = useIsOffline();

  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(offline ? 1 : 0, { duration: 200 });
  }, [offline, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * -8 }],
  }));

  if (!offline) return null;

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 900,
        elevation: 900,
      }}
    >
      <Animated.View
        style={[
          animatedStyle,
          {
            paddingTop: insets.top + 6,
            paddingBottom: 8,
            paddingHorizontal: theme.spacing.lg,
            backgroundColor: c.surface2,
            borderBottomWidth: 1,
            borderBottomColor: c.border,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          },
        ]}
      >
        <Icon name="cloud-offline-outline" size={16} color={c.muted} />
        <Text
          accessibilityRole="alert"
          style={{ ...theme.typography.caption, color: c.text2 }}
        >
          You’re offline — changes will sync when you reconnect.
        </Text>
      </Animated.View>
    </View>
  );
}
