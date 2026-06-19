/**
 * 1.6 Notifications priming — ask to enable reminders/alerts.
 *
 * Phase-1 notifications are local capture/expiry reminders. The OS permission
 * prompt is requested lazily (expo-notifications is loaded inside the handler so
 * this path stays web-exportable). "Maybe later" continues to legal (1.7).
 */
import { Stack, useRouter } from 'expo-router';
import { Platform, Text, View } from 'react-native';

import { PrimingHero } from '../../components/PrimingHero';
import { AuthScaffold } from '../../components/AuthScaffold';
import { useTheme } from '../../theme';
import { Button, Icon, type IconName } from '../../ui';

const ALERTS: { icon: IconName; title: string; body: string }[] = [
  { icon: 'alarm-outline', title: 'Capture reminder', body: 'A nudge so today’s recap doesn’t slip by.' },
  { icon: 'hourglass-outline', title: 'Expiring soon', body: 'Know before a montage disappears at 24h.' },
  { icon: 'heart-outline', title: 'Reactions & comments', body: 'When friends react to what you shared.' },
];

export default function NotificationsPriming() {
  const theme = useTheme();
  const router = useRouter();

  async function enable() {
    if (Platform.OS !== 'web') {
      try {
        const Notifications = await import('expo-notifications');
        await Notifications.requestPermissionsAsync();
      } catch {
        // permission module unavailable — continue regardless
      }
    }
    router.push('/(auth)/legal');
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Stay in the loop' }} />
      <AuthScaffold
        step={6}
        footer={
          <>
            <Button
              label="Turn on notifications"
              size="lg"
              fullWidth
              icon="notifications-outline"
              onPress={enable}
            />
            <Button
              label="Maybe later"
              variant="ghost"
              fullWidth
              onPress={() => router.push('/(auth)/legal')}
            />
          </>
        }
      >
        <PrimingHero
          icon="notifications"
          title="Stay in the loop"
          subtitle="Get gentle, pressure-free reminders so you never miss today’s window."
        />

        <View style={{ gap: theme.spacing.md, marginTop: theme.spacing.lg }}>
          {ALERTS.map((a) => (
            <View
              key={a.title}
              style={{
                flexDirection: 'row',
                gap: theme.spacing.md,
                alignItems: 'flex-start',
                padding: theme.spacing.md,
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.surface,
                borderWidth: 1,
                borderColor: theme.colors.border,
              }}
            >
              <Icon name={a.icon} size={22} color={theme.colors.accent} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ ...theme.typography.bodyStrong, color: theme.colors.text }}>
                  {a.title}
                </Text>
                <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>
                  {a.body}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </AuthScaffold>
    </>
  );
}
