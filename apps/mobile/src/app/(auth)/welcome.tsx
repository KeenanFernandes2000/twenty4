// (auth)/welcome — branded entry. The "twenty4" wordmark over a warm ember mark, a
// one-line tagline, a primary "Get started" CTA → sign-in, and a legal footer.
// Group initial route (set in (auth)/_layout via unstable_settings).
import { View, type ViewStyle } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen, Text, Button } from '@/ui';
import { useTheme } from '@/theme';

export default function WelcomeScreen() {
  const theme = useTheme();
  const router = useRouter();

  // The ember accent mark — a small gradient bar sitting above the wordmark.
  const markStyle: ViewStyle = {
    width: 56,
    height: 6,
    borderRadius: theme.radii.pill,
    marginBottom: theme.spacing.xxl,
  };

  return (
    <Screen>
      <View style={{ flex: 1 }}>
        {/* Brand block — vertically centered, generous spacing. */}
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <LinearGradient
            colors={theme.accentGradient}
            start={theme.accentGradientStart}
            end={theme.accentGradientEnd}
            style={markStyle}
          />
          <Text variant="display" weight="black" style={{ letterSpacing: -1 }}>
            twenty4
          </Text>
          <Text
            variant="bodyLg"
            color="muted"
            style={{ marginTop: theme.spacing.base }}
          >
            Your day, with your people.
          </Text>
        </View>

        {/* CTA + legal footer pinned to the bottom. */}
        <View style={{ gap: theme.spacing.xl, paddingBottom: theme.spacing.xl }}>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            title="Get started"
            testID="auth-get-started-button"
            accessibilityLabel="Get started"
            onPress={() => router.push('/(auth)/sign-in')}
          />
          <Text variant="caption" color="faint" align="center">
            By continuing you agree to our{' '}
            <Link href="/(auth)/legal" style={{ color: theme.colors.accent }}>
              Terms &amp; Privacy
            </Link>
            .
          </Text>
        </View>
      </View>
    </Screen>
  );
}
