// ScreenHeader — a lightweight in-content header for the (app) screens (the Stack
// has headerShown:false, so screens render their own). Optional back affordance,
// a title, and an optional trailing action slot. Ember-styled.
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/ui';
import { useTheme } from '@/theme';

export function ScreenHeader({
  title,
  back = true,
  right,
  onBack,
  testID,
}: {
  title: string;
  /** Show the back chevron. Default true. */
  back?: boolean;
  /** Trailing action node (e.g. a menu / sign-out button). */
  right?: ReactNode;
  /** Override back behaviour (defaults to router.back()). */
  onBack?: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  const router = useRouter();

  const handleBack = () => {
    if (onBack) return onBack();
    if (router.canGoBack()) router.back();
    else router.replace('/(app)');
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.base,
        paddingVertical: theme.spacing.base,
        minHeight: 48,
      }}
      testID={testID}
    >
      {back ? (
        <Pressable
          onPress={handleBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={12}
          testID="header-back-button"
          style={({ pressed }) => [{ paddingRight: theme.spacing.xs }, pressed ? { opacity: 0.6 } : null]}
        >
          <Text variant="h2" color="muted">
            {'‹'}
          </Text>
        </Pressable>
      ) : null}
      <Text variant="title" numberOfLines={1} style={{ flex: 1 }}>
        {title}
      </Text>
      {right != null ? <View>{right}</View> : null}
    </View>
  );
}
