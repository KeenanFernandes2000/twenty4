/**
 * Screen — themed safe-area scaffold for placeholder/real screens.
 */
import { ScrollView, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

export interface ScreenProps {
  children: React.ReactNode;
  scroll?: boolean;
  center?: boolean;
  padded?: boolean;
  contentStyle?: ViewStyle;
}

export function Screen({
  children,
  scroll = false,
  center = false,
  padded = true,
  contentStyle,
}: ScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const padding: ViewStyle = {
    paddingTop: insets.top + (padded ? theme.spacing.lg : 0),
    paddingBottom: insets.bottom + (padded ? theme.spacing.lg : 0),
    paddingHorizontal: padded ? theme.spacing.lg : 0,
  };

  if (scroll) {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.bg }}
        contentContainerStyle={[
          padding,
          { gap: theme.spacing.lg },
          center && { flexGrow: 1, justifyContent: 'center' },
          contentStyle,
        ]}
      >
        {children}
      </ScrollView>
    );
  }

  return (
    <View
      style={[
        { flex: 1, backgroundColor: theme.colors.bg, gap: theme.spacing.lg },
        padding,
        center && { alignItems: 'center', justifyContent: 'center' },
        contentStyle,
      ]}
    >
      {children}
    </View>
  );
}
