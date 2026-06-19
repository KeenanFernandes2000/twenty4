/**
 * 2.7 Music picker — "Add music". Pick a track from /montages/options →
 * regenerate. Selecting a row + "Use <track>" POSTs the new musicId to
 * /montages/:id/regenerate (keeps the current theme) and routes back through 2.4
 * Generating.
 *
 * Design (Spool 2.7): a list of track rows (play glyph + label + bpm/meta); the
 * selected row gets an accent fill + border + an equalizer hint. Web-safe via
 * the mock options.
 */
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { useTheme } from '../../../theme';
import { Button, Icon, Skeleton } from '../../../ui';
import { useMontage, useMontageOptions, useRegenerate, montageErrorMessage } from '../../../lib/montage';
import { montageMockActive, mockMontageForMode, MOCK_MONTAGE_OPTIONS } from '../../../lib/montageMocks';
import type { MusicTrackOption } from '@twenty4/contracts/dto';

export default function MusicPicker() {
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

  const [selected, setSelected] = useState<string>(current?.musicId ?? options?.defaultMusicId ?? 'golden-hour');

  const tracks = options?.music ?? [];
  const selectedLabel = tracks.find((t) => t.id === selected)?.label ?? 'track';

  const apply = () => {
    if (mock || !id) return;
    regenerate.mutate(
      { musicId: selected, theme: (current?.theme as never) ?? undefined },
      {
        onSuccess: () => router.replace({ pathname: '/(main)/today/generating', params: { id } }),
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: 'Add music' }} />
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <Text style={{ ...theme.typography.title, color: c.text }}>Add music</Text>
        <Text style={{ ...theme.typography.body, color: c.muted }}>
          The track drives the cut — clips snap to its beat. Pick one to re-cut your recap.
        </Text>

        {options ? (
          <View style={{ gap: theme.spacing.sm }}>
            {tracks.map((t) => (
              <TrackRow key={t.id} track={t} selected={t.id === selected} onPress={() => setSelected(t.id)} />
            ))}
          </View>
        ) : optionsQuery.isError ? (
          <Text style={{ ...theme.typography.body, color: c.danger }}>{montageErrorMessage(optionsQuery.error)}</Text>
        ) : (
          <View style={{ gap: theme.spacing.sm }}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} width="100%" height={58} radius={theme.radii.lg} />
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
          label={`Use ${selectedLabel}`}
          icon="checkmark"
          fullWidth
          size="lg"
          loading={regenerate.isPending}
          onPress={apply}
        />
      </View>
    </View>
  );
}

function TrackRow({
  track,
  selected,
  onPress,
}: {
  track: MusicTrackOption;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const isNoMusic = track.id === 'no-music';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        padding: theme.spacing.md,
        borderRadius: theme.radii.lg,
        borderWidth: 1,
        borderColor: selected ? c.accent : c.border,
        backgroundColor: selected ? c.accentSoft : c.surface,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: theme.radii.md,
          backgroundColor: selected ? c.accent : c.surface2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon
          name={isNoMusic ? 'volume-mute' : selected ? 'pause' : 'musical-note'}
          size={18}
          color={selected ? '#fff' : c.muted}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ ...theme.typography.bodyStrong, color: c.text }}>{track.label}</Text>
        <Text style={{ ...theme.typography.caption, color: c.muted }}>
          {isNoMusic ? 'Silent · clips cut on a fixed grid' : `${track.bpm} BPM${track.synthesized ? ' · preview' : ''}`}
        </Text>
      </View>
      {selected ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 18 }}>
          {[8, 16, 11, 14].map((h, i) => (
            <View key={i} style={{ width: 2.5, height: h, borderRadius: 2, backgroundColor: c.accent }} />
          ))}
        </View>
      ) : (
        <Icon name="ellipse-outline" size={20} color={c.faint} />
      )}
    </Pressable>
  );
}
