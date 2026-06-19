/**
 * 2.9 Publish success — "You're live!". Confirmation after a successful publish:
 * a celebratory hero, the groups it went to, the 24h countdown, and the two next
 * actions (View in feed / Download to my device / Done).
 *
 * Data: useMontage(id) reads back the published montage (published_at +
 * expiry_at) for the countdown. Web-safe via the mock montage (status=published).
 */
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { useTheme } from '../../../theme';
import { Button, Icon } from '../../../ui';
import { timeRemaining } from '../../../features/montage/labels';
import { useMontage } from '../../../lib/montage';
import { scheduleExpiryReminder } from '../../../lib/reminders';
import { montageMockActive, mockMontageForMode } from '../../../lib/montageMocks';

export default function Published() {
  const theme = useTheme();
  const c = theme.colors;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, groups } = useLocalSearchParams<{ id?: string; groups?: string }>();

  const mock = montageMockActive();
  const query = useMontage(id, { enabled: !mock, pollMs: 60_000 });
  const montage = mock ? mockMontageForMode() : query.data;

  // Local reminder (Phase-1): once we know the published montage's expiry, schedule
  // a one-shot "expiring soon" nudge ~2h before the 24h hard-delete. No-op on web /
  // when notifications aren't granted; replaces any prior reminder for this id.
  const expiryAt = montage?.expiryAt;
  useEffect(() => {
    if (mock || !id || !expiryAt) return;
    void scheduleExpiryReminder({ montageId: id, expiryAt });
  }, [mock, id, expiryAt]);

  const remaining = timeRemaining(montage?.expiryAt) ?? '23h 59m';
  // Group names: passed through the route params on publish, or mock copy.
  const groupNames = groups ? groups.split('•').filter(Boolean) : mock ? ['Close Circle', 'Roommates'] : [];

  const sharedTo =
    groupNames.length === 0
      ? 'your groups'
      : groupNames.length === 1
        ? groupNames[0]
        : groupNames.length === 2
          ? `${groupNames[0]} and ${groupNames[1]}`
          : `${groupNames.slice(0, -1).join(', ')} and ${groupNames[groupNames.length - 1]}`;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.bg,
        paddingTop: insets.top + theme.spacing.xl,
        paddingBottom: insets.bottom + theme.spacing.lg,
        paddingHorizontal: theme.spacing.xl,
        alignItems: 'center',
      }}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1 }} />

      {/* Celebratory hero */}
      <View
        style={{
          width: 96,
          height: 96,
          borderRadius: 48,
          backgroundColor: c.accentSoft,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: theme.spacing.lg,
        }}
      >
        <Icon name="checkmark-circle" size={64} color={c.accent} />
      </View>

      <Text style={{ ...theme.typography.display, color: c.text, textAlign: 'center' }}>You’re live!</Text>
      <Text
        style={{
          ...theme.typography.body,
          color: c.text2,
          textAlign: 'center',
          marginTop: theme.spacing.sm,
          paddingHorizontal: theme.spacing.md,
        }}
      >
        Your recap is now in <Text style={{ color: c.text, fontFamily: theme.fontFamily.bold }}>{sharedTo}</Text>.
      </Text>

      {/* 24h countdown pill */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginTop: theme.spacing.lg,
          paddingVertical: 8,
          paddingHorizontal: 14,
          borderRadius: theme.radii.pill,
          backgroundColor: c.surface2,
          borderWidth: 1,
          borderColor: c.border,
        }}
      >
        <Icon name="time-outline" size={15} color={c.accent2} />
        <Text style={{ ...theme.typography.bodyStrong, color: c.text2 }}>Gone in {remaining}</Text>
      </View>

      <View style={{ flex: 1 }} />

      <View style={{ alignSelf: 'stretch', gap: theme.spacing.sm }}>
        <Button label="View in feed" icon="play-circle" fullWidth size="lg" onPress={() => router.replace('/(main)/feed')} />
        <Button
          label="Download to my device"
          icon="download-outline"
          variant="secondary"
          fullWidth
          onPress={() => undefined}
        />
        <View style={{ alignItems: 'center', marginTop: theme.spacing.xs }}>
          <Text
            accessibilityRole="button"
            onPress={() => router.replace('/(main)/today')}
            style={{ ...theme.typography.bodyStrong, color: c.muted }}
          >
            Done
          </Text>
        </View>
      </View>
    </View>
  );
}
