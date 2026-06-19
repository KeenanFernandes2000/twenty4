/**
 * AuthScaffold — shared layout for the (auth) onboarding screens (1.1–1.7).
 *
 * Themed safe-area canvas with a keyboard-avoiding scroll body, an optional
 * step progress dot row, a title/subtitle header, and a pinned footer for the
 * primary CTA. All colors come from the theme — no hardcoded values.
 */
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';

/** Total onboarding steps for the progress row (welcome → legal). */
export const AUTH_STEPS = 7;

function StepDots({ step }: { step: number }) {
  const theme = useTheme();
  return (
    <View
      accessibilityLabel={`Step ${step} of ${AUTH_STEPS}`}
      style={{ flexDirection: 'row', gap: theme.spacing.xs, justifyContent: 'center' }}
    >
      {Array.from({ length: AUTH_STEPS }).map((_, i) => {
        const active = i < step;
        return (
          <View
            key={i}
            style={{
              width: i === step - 1 ? 22 : 7,
              height: 7,
              borderRadius: theme.radii.pill,
              backgroundColor: active ? theme.colors.accent : theme.colors.surface3,
            }}
          />
        );
      })}
    </View>
  );
}

export interface AuthScaffoldProps {
  children: React.ReactNode;
  /** 1-based step (drives the progress dots). Omit to hide them. */
  step?: number;
  /** Big screen title. */
  title?: string;
  /** Supporting line under the title. */
  subtitle?: string;
  /** Pinned footer content (usually the primary CTA + helper links). */
  footer?: React.ReactNode;
  contentStyle?: ViewStyle;
}

export function AuthScaffold({
  children,
  step,
  title,
  subtitle,
  footer,
  contentStyle,
}: AuthScaffoldProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          {
            flexGrow: 1,
            paddingTop: insets.top + theme.spacing.lg,
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: theme.spacing.lg,
            gap: theme.spacing.lg,
          },
          contentStyle,
        ]}
      >
        {step ? <StepDots step={step} /> : null}
        {title ? (
          <View style={{ gap: theme.spacing.xs }}>
            <Text style={{ ...theme.typography.title, color: theme.colors.text }}>{title}</Text>
            {subtitle ? (
              <Text style={{ ...theme.typography.body, color: theme.colors.muted }}>{subtitle}</Text>
            ) : null}
          </View>
        ) : null}
        {children}
      </ScrollView>
      {footer ? (
        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.md,
            paddingBottom: insets.bottom + theme.spacing.lg,
            gap: theme.spacing.md,
            backgroundColor: theme.colors.bg,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
          }}
        >
          {footer}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
