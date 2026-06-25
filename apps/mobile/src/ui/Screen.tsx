import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  SafeAreaView,
  type Edge,
} from 'react-native-safe-area-context';
import { useTheme } from '../theme';

export interface ScreenProps {
  children: ReactNode;
  /** Wrap content in a ScrollView. */
  scroll?: boolean;
  /** Apply default horizontal padding (spacing.xl). Default: true. */
  padded?: boolean;
  /** Wrap in a KeyboardAvoidingView (forms). Default: false. */
  keyboardAvoiding?: boolean;
  /** Safe-area edges to inset. Default: top + bottom. */
  edges?: readonly Edge[];
  /** Background color override (defaults to theme bg). */
  backgroundColor?: string;
  style?: StyleProp<ViewStyle>;
  /** Extra style for the inner content container (e.g. ScrollView contentContainerStyle). */
  contentStyle?: StyleProp<ViewStyle>;
}

const DEFAULT_EDGES: readonly Edge[] = ['top', 'bottom'];

export function Screen({
  children,
  scroll = false,
  padded = true,
  keyboardAvoiding = false,
  edges = DEFAULT_EDGES,
  backgroundColor,
  style,
  contentStyle,
}: ScreenProps) {
  const theme = useTheme();
  const bg = backgroundColor ?? theme.colors.bg;
  const paddingStyle: ViewStyle | null = padded
    ? { paddingHorizontal: theme.spacing.xl }
    : null;

  const content = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.scrollContent,
        paddingStyle,
        contentStyle,
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, paddingStyle, contentStyle]}>{children}</View>
  );

  const body = keyboardAvoiding ? (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {content}
    </KeyboardAvoidingView>
  ) : (
    content
  );

  return (
    <SafeAreaView
      edges={edges}
      style={[styles.flex, { backgroundColor: bg }, style]}
    >
      {body}
    </SafeAreaView>
  );
}

const styles = {
  flex: { flex: 1 } as ViewStyle,
  scrollContent: { flexGrow: 1, paddingVertical: 0 } as ViewStyle,
};
