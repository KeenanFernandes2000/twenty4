/**
 * 2.5 Montage review — the draft is ready; the user previews it and decides.
 *
 * - Plays the draft via <MontagePlayer/> (expo-video on device; web shows the
 *   thumbnail/placeholder, since autoplay+sound is device-verified).
 * - Theme / Music / Regenerate entry points (→ 2.6 / 2.7 / re-render in place).
 * - Publish CTA → 2.8 (multi-group publish).
 * - "Live for 24h after you publish" + a 24h chip set the expiry expectation.
 *
 * Data: useMontage(id) (no longer polling once draft_ready) + useMontageOptions
 * for the music label. Regenerate routes back through 2.4 Generating. Web-safe
 * via the mock layer (status='draft_ready').
 */
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { useTheme } from '../../../theme';
import { Button, Card, ErrorRetry, Icon, Skeleton } from '../../../ui';
import { MontagePlayer } from '../../../features/montage/MontagePlayer';
import { musicLabel, timeRemaining } from '../../../features/montage/labels';
import { useMontage, useMontageOptions, montageErrorMessage } from '../../../lib/montage';
import { montageMockActive, mockMontageForMode, MOCK_MONTAGE_OPTIONS } from '../../../lib/montageMocks';
import type { MontageResponse, MontageOptionsResponse } from '@twenty4/contracts/dto';

export default function Review() {
  const theme = useTheme();
  const c = theme.colors;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const mock = montageMockActive();
  const query = useMontage(id, { enabled: !mock });
  const optionsQuery = useMontageOptions({ enabled: !mock });

  const montage: MontageResponse | undefined = mock ? mockMontageForMode() ?? undefined : query.data;
  const options: MontageOptionsResponse | undefined = mock ? MOCK_MONTAGE_OPTIONS : optionsQuery.data;

  const isLoading = !mock && query.isLoading;
  const isError = !mock && query.isError && !query.notFound;
  const published = montage?.status === 'published';

  const goTheme = () => router.push({ pathname: '/(main)/today/theme', params: { id } });
  const goMusic = () => router.push({ pathname: '/(main)/today/music', params: { id } });
  const goPublish = () => router.push({ pathname: '/(main)/today/publish', params: { id } });
  const regenerate = () => router.push({ pathname: '/(main)/today/theme', params: { id } });

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: 'Review', headerBackTitle: 'Today' }} />
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xl,
          gap: theme.spacing.lg,
        }}
      >
        {isLoading ? (
          <Skeleton width="100%" height={300} radius={theme.radii.xl} />
        ) : isError ? (
          <ErrorRetry message={montageErrorMessage(query.error)} onRetry={() => query.refetch()} />
        ) : !montage ? (
          <ErrorRetry message="This montage is no longer available." onRetry={() => router.replace('/(main)/today')} />
        ) : (
          <>
            <MontagePlayer
              videoUrl={montage.videoUrl}
              thumbnailUrl={montage.thumbnailUrl}
              state={published ? 'published' : 'draft'}
              height={320}
            />

            {/* Title row + 24h chip */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ ...theme.typography.heading, color: c.text }}>Today’s recap</Text>
                <Text style={{ ...theme.typography.caption, color: c.muted }}>
                  {published ? 'Live now' : 'Live for 24h after you publish'}
                </Text>
              </View>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                  paddingVertical: 6,
                  paddingHorizontal: 11,
                  borderRadius: theme.radii.pill,
                  backgroundColor: c.accentSoft,
                }}
              >
                <Icon name="time-outline" size={13} color={c.accent} />
                <Text style={{ ...theme.typography.label, color: c.accent }}>
                  {published ? timeRemaining(montage.expiryAt) ?? '24h' : '24h'}
                </Text>
              </View>
            </View>

            {/* Edit grid: theme / music / regenerate / clips */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
              <EditTile icon="color-palette-outline" label="Theme" value={montage.theme ?? 'Chill'} onPress={goTheme} />
              <EditTile icon="musical-notes-outline" label="Music" value={musicLabel(montage.musicId, options)} onPress={goMusic} />
              <EditTile icon="refresh-outline" label="Regenerate" value="New cut" onPress={regenerate} />
              <EditTile icon="film-outline" label="Duration" value={`${Math.round((montage.durationMs ?? 30000) / 1000)}s · 9:16`} />
            </View>

            {/* Primary CTA */}
            <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.xs }}>
              <Button
                label={published ? 'Update groups' : 'Publish recap'}
                icon="arrow-forward"
                fullWidth
                size="lg"
                onPress={goPublish}
              />
              <View style={{ flexDirection: 'row', justifyContent: 'center', gap: theme.spacing.xl, marginTop: 4 }}>
                <Text style={{ ...theme.typography.bodyStrong, color: c.muted }}>Download</Text>
                <Text
                  accessibilityRole="button"
                  onPress={() => router.replace('/(main)/today')}
                  style={{ ...theme.typography.bodyStrong, color: c.danger }}
                >
                  Discard draft
                </Text>
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

/** A 2-up edit tile (theme/music/regenerate/duration). Non-pressable when no onPress. */
function EditTile({
  icon,
  label,
  value,
  onPress,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  value: string;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <Card padded={false} style={{ flexBasis: '48%', flexGrow: 1, opacity: onPress ? 1 : 0.75 }}>
      <Pressable
        accessibilityRole={onPress ? 'button' : undefined}
        disabled={!onPress}
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          padding: theme.spacing.md,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Icon name={icon} size={18} color={c.accent} />
        <View style={{ flex: 1 }}>
          <Text style={{ ...theme.typography.label, color: c.muted }}>{label}</Text>
          <Text numberOfLines={1} style={{ ...theme.typography.bodyStrong, color: c.text }}>
            {value}
          </Text>
        </View>
      </Pressable>
    </Card>
  );
}
