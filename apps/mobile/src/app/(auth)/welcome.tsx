/**
 * 1.1 Welcome — the onboarding entry. Brand hero + value props + a single CTA
 * into sign-in (1.2). Fully themed; web-safe (no native-only imports).
 */
import { Stack, useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { AuthScaffold } from '../../components/AuthScaffold';
import { useTheme } from '../../theme';
import { Button, Icon, type IconName } from '../../ui';

const VALUE_PROPS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'time-outline',
    title: 'Today only',
    body: 'Collect the moments from your day — they’re gone in 24 hours.',
  },
  {
    icon: 'sparkles-outline',
    title: 'Auto montage',
    body: 'We stitch your media into a themed recap with licensed music.',
  },
  {
    icon: 'people-outline',
    title: 'Private groups',
    body: 'Share to the small circles that matter. No public feed.',
  },
];

export default function Welcome() {
  const theme = useTheme();
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <AuthScaffold
        footer={
          <Button
            label="Get started"
            icon="arrow-forward"
            size="lg"
            fullWidth
            onPress={() => router.push('/(auth)/sign-in')}
          />
        }
      >
        <View style={{ flex: 1, justifyContent: 'center', gap: theme.spacing['2xl'] }}>
          {/* Brand hero */}
          <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
            <View
              style={{
                width: 76,
                height: 76,
                borderRadius: theme.radii['2xl'],
                backgroundColor: theme.colors.accentSoft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="flame" size={40} color={theme.colors.accent} />
            </View>
            <Text style={{ ...theme.typography.display, color: theme.colors.accent }}>twenty4</Text>
            <Text
              style={{
                ...theme.typography.subheading,
                color: theme.colors.text2,
                textAlign: 'center',
              }}
            >
              Today’s moments. Gone in 24h.
            </Text>
          </View>

          {/* Value props */}
          <View style={{ gap: theme.spacing.lg }}>
            {VALUE_PROPS.map((vp) => (
              <View
                key={vp.title}
                style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'flex-start' }}
              >
                <View
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: theme.radii.md,
                    backgroundColor: theme.colors.surface2,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name={vp.icon} size={20} color={theme.colors.accent} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ ...theme.typography.bodyStrong, color: theme.colors.text }}>
                    {vp.title}
                  </Text>
                  <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>
                    {vp.body}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      </AuthScaffold>
    </>
  );
}
