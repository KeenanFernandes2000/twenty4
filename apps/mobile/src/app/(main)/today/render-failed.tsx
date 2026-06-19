/**
 * ⚠ render-failed — one of the 3 undesigned screens (built functionally in the
 * Ember system, flagged for design). Reached when the render job exhausts its
 * retries (§7.4 attempts:2) and the montage lands in `failed`.
 *
 * Offers a retry that re-runs the SAME montage via /montages/:id/regenerate
 * (keeping the chosen theme/music) and routes back through 2.4 Generating, plus
 * a "tweak it" path to the theme/music pickers and a "back to Today" escape.
 * FORCED DARK to match the generating/review surface chrome.
 *
 * Web-safe via the mock layer (status='failed').
 */
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { ForcedDarkProvider, useTheme } from '../../../theme';
import { Button, Icon } from '../../../ui';
import { useMontage, useRegenerate } from '../../../lib/montage';
import { montageMockActive, mockMontageForMode } from '../../../lib/montageMocks';

export default function RenderFailedRoute() {
  return (
    <ForcedDarkProvider>
      <RenderFailed />
    </ForcedDarkProvider>
  );
}

function RenderFailed() {
  const theme = useTheme();
  const c = theme.colors;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const mock = montageMockActive();
  const query = useMontage(id, { enabled: !mock });
  const montage = mock ? mockMontageForMode() : query.data;

  const regenerate = useRegenerate(id ?? '');

  const retry = () => {
    if (mock || !id) return;
    regenerate.mutate(
      { theme: (montage?.theme as never) ?? undefined, musicId: montage?.musicId ?? undefined },
      { onSuccess: () => router.replace({ pathname: '/(main)/today/generating', params: { id } }) },
    );
  };

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

      <View
        style={{
          width: 96,
          height: 96,
          borderRadius: 48,
          backgroundColor: c.surface2,
          borderWidth: 1,
          borderColor: c.border,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: theme.spacing.lg,
        }}
      >
        <Icon name="alert-circle-outline" size={56} color={c.danger} />
      </View>

      <Text style={{ ...theme.typography.title, color: c.text, textAlign: 'center' }}>
        That cut didn’t come together
      </Text>
      <Text
        style={{
          ...theme.typography.body,
          color: c.text2,
          textAlign: 'center',
          marginTop: theme.spacing.sm,
          paddingHorizontal: theme.spacing.md,
        }}
      >
        Something went wrong while building your montage. Your moments are safe — give it another go, or change the
        theme or music first.
      </Text>

      {regenerate.isError ? (
        <Text style={{ ...theme.typography.caption, color: c.danger, marginTop: theme.spacing.md, textAlign: 'center' }}>
          Couldn’t restart the render. Please try again.
        </Text>
      ) : null}

      <View style={{ flex: 1 }} />

      <View style={{ alignSelf: 'stretch', gap: theme.spacing.sm }}>
        <Button label="Try again" icon="refresh" fullWidth size="lg" loading={regenerate.isPending} onPress={retry} />
        <Button
          label="Change theme or music"
          icon="options-outline"
          variant="secondary"
          fullWidth
          onPress={() => router.replace({ pathname: '/(main)/today/theme', params: { id } })}
        />
        <View style={{ alignItems: 'center', marginTop: theme.spacing.xs }}>
          <Text
            accessibilityRole="button"
            onPress={() => router.replace('/(main)/today')}
            style={{ ...theme.typography.bodyStrong, color: c.muted }}
          >
            Back to Today
          </Text>
        </View>
      </View>
    </View>
  );
}
