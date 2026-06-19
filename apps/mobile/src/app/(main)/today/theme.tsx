/**
 * 2.6 Theme picker — "Pick a vibe". Choose a theme from /montages/options →
 * regenerate. Selecting a card + "Apply & regenerate" POSTs the new theme to
 * /montages/:id/regenerate (keeps the current music) and routes back through 2.4
 * Generating so the new cut renders.
 *
 * Design (Spool 2.6): 2-col grid of gradient theme cards; the selected card gets
 * an accent border + a check badge. Web-safe via the mock options.
 */
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { useTheme } from '../../../theme';
import { Button, Icon, Skeleton } from '../../../ui';
import { themeGradient } from '../../../features/montage/labels';
import { GradientCard } from '../../../features/montage/GradientCard';
import { useMontage, useMontageOptions, useRegenerate, montageErrorMessage } from '../../../lib/montage';
import { montageMockActive, mockMontageForMode, MOCK_MONTAGE_OPTIONS } from '../../../lib/montageMocks';
import type { Theme as ThemeName } from '@twenty4/contracts/enums';

export default function ThemePicker() {
  const theme = useTheme();
  const c = theme.colors;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const mock = montageMockActive();
  const optionsQuery = useMontageOptions({ enabled: !mock });
  const montageQuery = useMontage(id, { enabled: !mock });
  const options = mock ? MOCK_MONTAGE_OPTIONS : optionsQuery.data;
  const current = mock ? mockMontageForMode() : montageQuery.data;

  const regenerate = useRegenerate(id ?? '');

  const [selected, setSelected] = useState<ThemeName>((current?.theme as ThemeName) ?? 'Chill');

  const themes = options?.themes ?? [];

  const apply = () => {
    if (mock || !id) return;
    regenerate.mutate(
      { theme: selected, musicId: current?.musicId ?? undefined },
      {
        onSuccess: () => router.replace({ pathname: '/(main)/today/generating', params: { id } }),
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: 'Pick a vibe' }} />
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <Text style={{ ...theme.typography.title, color: c.text }}>Pick a vibe</Text>
        <Text style={{ ...theme.typography.body, color: c.muted }}>
          The theme sets the pacing, transitions, and feel. Apply to re-cut your recap.
        </Text>

        {options ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {themes.map((t) => {
              const [from, to] = themeGradient(t);
              const isSel = t === selected;
              return (
                <Pressable
                  key={t}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSel }}
                  onPress={() => setSelected(t)}
                  style={{ flexBasis: '47%', flexGrow: 1 }}
                >
                  <GradientCard
                    from={from}
                    to={to}
                    style={{
                      aspectRatio: 1.2,
                      borderRadius: theme.radii.lg,
                      borderWidth: isSel ? 2.5 : 0,
                      borderColor: isSel ? c.accent : 'transparent',
                      overflow: 'hidden',
                      justifyContent: 'flex-end',
                    }}
                  >
                    {isSel ? (
                      <View
                        style={{
                          position: 'absolute',
                          top: 8,
                          right: 8,
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          backgroundColor: c.accent,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Icon name="checkmark" size={14} color="#fff" />
                      </View>
                    ) : null}
                    <View
                      style={{
                        paddingHorizontal: theme.spacing.md,
                        paddingVertical: theme.spacing.sm,
                        backgroundColor: 'rgba(0,0,0,0.35)',
                      }}
                    >
                      <Text style={{ color: '#fff', fontFamily: theme.fontFamily.extrabold, fontSize: 14 }}>{t}</Text>
                    </View>
                  </GradientCard>
                </Pressable>
              );
            })}
          </View>
        ) : optionsQuery.isError ? (
          <Text style={{ ...theme.typography.body, color: c.danger }}>{montageErrorMessage(optionsQuery.error)}</Text>
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} width="47%" height={120} radius={theme.radii.lg} />
            ))}
          </View>
        )}
      </ScrollView>

      <View
        style={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.md,
          borderTopWidth: 1,
          borderColor: c.border,
          backgroundColor: c.bg,
        }}
      >
        <Button
          label="Apply & regenerate"
          icon="refresh"
          fullWidth
          size="lg"
          loading={regenerate.isPending}
          onPress={apply}
        />
      </View>
    </View>
  );
}
