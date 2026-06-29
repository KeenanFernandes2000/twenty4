// MontageReview — the M7 review screen body (rendered by the montage host once the
// render reaches draft_ready / published). Inline mp4 preview, expiry info,
// group multi-select publish, a basic theme/music picker, regenerate, and
// remove-media-and-regenerate. Ember-styled; web-safe (the preview is the
// platform-split MontagePreview).
//
// Contract note: `POST /montages/:id/regenerate` accepts `{ mediaIds?, theme?,
// musicId? }`. The theme/music picker selections are threaded into both regenerate
// paths below, so tapping Regenerate after changing the theme re-skins the render
// (omitted fields keep the row's current value).
import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { MediaItemDTO, MontageDTO, Theme } from '@twenty4/contracts';
import { Button, Card, Screen, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { confirm } from '@/lib/confirm';
import { useMontageOptions, usePublishMontage, useReplaceMontage } from '@/lib/montage';
import { useTodayBucket } from '@/lib/media';
import { useMontageStore, useMontageStarting } from '@/stores/montageStore';
import { MontagePreview } from '@/components/montage/MontagePreview';

const THEME_LABEL: Record<Theme, string> = {
  chill: 'Chill',
  party: 'Party',
  clean: 'Clean',
  travel: 'Travel',
  random: 'Random',
  fast_cut: 'Fast cut',
  soft: 'Soft',
};

// A small selectable pill used by the theme/group pickers.
function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      testID={testID}
      style={{
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.sm,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accentSoft : theme.colors.surface2,
      }}
    >
      <Text variant="caption" color={selected ? 'accent' : 'secondary'}>
        {label}
      </Text>
    </Pressable>
  );
}

export function MontageReview({ montage }: { montage: MontageDTO }) {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();

  const regenerate = useMontageStore((s) => s.regenerate);
  const starting = useMontageStarting();
  const optionsQuery = useMontageOptions();
  const groupsQuery = useQuery({ queryKey: queryKeys.groups.list, queryFn: () => api.listGroups() });
  const todayQuery = useTodayBucket();
  const publish = usePublishMontage();
  const replace = useReplaceMontage();

  // Cross-reference today's bucket so each source clip can show a real thumbnail.
  const mediaById = useMemo(() => {
    const map = new Map<string, MediaItemDTO>();
    for (const it of todayQuery.data?.items ?? []) map.set(it.id, it);
    return map;
  }, [todayQuery.data]);

  // ── Local selection state ──────────────────────────────────────────────────
  const [selectedTheme, setSelectedTheme] = useState<Theme>(montage.theme);
  const [selectedMusic, setSelectedMusic] = useState<string>(montage.musicId);
  // Kept source clips (init = all). Deselecting some → remove-and-regenerate.
  const [kept, setKept] = useState<Set<string>>(() => new Set(montage.sourceMediaIds));
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(() => new Set());

  const isPublished = montage.status === 'published' || publish.isSuccess;
  const droppedCount = montage.sourceMediaIds.length - kept.size;
  const canRemoveRegen = droppedCount > 0 && kept.size >= 1 && !starting;

  const toggle = (set: Set<string>, id: string, update: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
  };

  const onRegenerate = () => {
    regenerate(montage.id, { theme: selectedTheme, musicId: selectedMusic }).catch(() => {
      toast.show({ type: 'error', message: useMontageStore.getState().error ?? 'Could not regenerate' });
    });
  };

  const onRemoveRegenerate = () => {
    regenerate(montage.id, { mediaIds: [...kept], theme: selectedTheme, musicId: selectedMusic }).catch(() => {
      toast.show({ type: 'error', message: useMontageStore.getState().error ?? 'Could not regenerate' });
    });
  };

  const onPublish = () => {
    const groupIds = [...selectedGroups];
    if (groupIds.length === 0) {
      toast.show({ type: 'info', message: 'Pick at least one group' });
      return;
    }
    publish.mutate(
      { id: montage.id, body: { groupIds } },
      {
        onSuccess: () => toast.show({ type: 'success', message: 'Published!' }),
        onError: () => toast.show({ type: 'error', message: 'Could not publish. Please try again.' }),
      },
    );
  };

  // M9 replace-before-expiry (owner-only; this screen only ever shows the caller's
  // own montage). Generating a replacement and publishing it hard-deletes THIS recap
  // plus all its reactions/comments — so warn, then route into the new montage's
  // generate → review flow.
  const onReplace = async () => {
    const ok = await confirm({
      title: 'Replace this recap?',
      message:
        'We’ll build a new recap for today. When you publish it, this recap — and all of its reactions and comments — is permanently discarded. This can’t be undone.',
      confirmLabel: 'Replace',
    });
    if (!ok) return;
    replace.mutate(
      { id: montage.id },
      {
        onSuccess: (res) => {
          // Point the in-flight tracker at the replacement and open its host screen
          // (it polls generate → review just like a fresh montage).
          useMontageStore.setState({ current: { id: res.montageId, status: res.status } });
          router.replace(`/(app)/montage/${res.montageId}`);
        },
        onError: () =>
          toast.show({ type: 'error', message: 'Could not start a replacement. Please try again.' }),
      },
    );
  };

  const groups = groupsQuery.data ?? [];

  return (
    <Screen padded={false}>
      <View style={{ flex: 1 }} testID="montage-review">
        <View style={{ paddingHorizontal: theme.spacing.xl }}>
          <ScreenHeader title="Your montage" onBack={() => router.replace('/(app)/today')} />
        </View>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.base,
            paddingBottom: theme.spacing.section,
            gap: theme.spacing.lg,
          }}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Inline mp4 preview ─────────────────────────────────────────── */}
          <MontagePreview uri={montage.previewUrl} />

          {/* ── Expiry info ────────────────────────────────────────────────── */}
          <Card variant="compact" flat>
            <Text variant="caption" color="muted">
              Recaps are ephemeral — once you publish, this montage is deleted 24h after publish.
            </Text>
          </Card>

          {/* ── Publish-success state ──────────────────────────────────────── */}
          {isPublished ? (
            <View testID="publish-success">
              <Card variant="compact">
                <View style={{ gap: theme.spacing.sm }}>
                  <Text variant="body" color="success">
                    Published to your group{selectedGroups.size === 1 ? '' : 's'} 🎉
                  </Text>
                  <Text variant="caption" color="muted">
                    It will disappear 24h after publishing.
                  </Text>
                  <Button
                    variant="secondary"
                    fullWidth
                    title="Back to Today"
                    onPress={() => router.replace('/(app)/today')}
                    testID="montage-done"
                  />
                  <Button
                    variant="ghost"
                    fullWidth
                    title="Replace this recap"
                    onPress={onReplace}
                    loading={replace.isPending}
                    disabled={replace.isPending}
                    testID="montage-replace"
                  />
                  <Text variant="micro" color="muted">
                    Replacing builds a new recap; publishing it permanently discards this one and its
                    reactions and comments.
                  </Text>
                </View>
              </Card>
            </View>
          ) : null}

          {/* ── Theme / music picker (functional selection) ────────────────── */}
          {!isPublished ? (
            <View style={{ gap: theme.spacing.base }}>
              <Text variant="micro" color="label">
                Theme
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
                {(optionsQuery.data?.themes ?? [montage.theme]).map((t) => (
                  <Chip
                    key={t}
                    label={THEME_LABEL[t] ?? t}
                    selected={selectedTheme === t}
                    onPress={() => setSelectedTheme(t)}
                    testID={`theme-select-${t}`}
                  />
                ))}
              </View>

              {(optionsQuery.data?.tracks?.length ?? 0) > 0 ? (
                <>
                  <Text variant="micro" color="label" style={{ marginTop: theme.spacing.sm }}>
                    Music
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
                    {optionsQuery.data!.tracks.map((tr) => (
                      <Chip
                        key={tr.id}
                        label={tr.title}
                        selected={selectedMusic === tr.id}
                        onPress={() => setSelectedMusic(tr.id)}
                        testID={`track-select-${tr.id}`}
                      />
                    ))}
                  </View>
                </>
              ) : null}
            </View>
          ) : null}

          {/* ── Source clips (deselect → remove-and-regenerate) ────────────── */}
          {!isPublished && montage.sourceMediaIds.length > 0 ? (
            <View style={{ gap: theme.spacing.base }}>
              <Text variant="micro" color="label">
                Clips · {kept.size}/{montage.sourceMediaIds.length}
                {droppedCount > 0 ? ` · ${droppedCount} removed` : ''}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
                {montage.sourceMediaIds.map((mid) => {
                  const item = mediaById.get(mid);
                  const inSet = kept.has(mid);
                  const thumb = item?.thumbnailUrl ?? (item?.mediaType === 'photo' ? item?.downloadUrl : null);
                  return (
                    <Pressable
                      key={mid}
                      onPress={() => toggle(kept, mid, setKept)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: inSet }}
                      testID={`montage-media-${mid}`}
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: theme.radii.md,
                        overflow: 'hidden',
                        borderWidth: 2,
                        borderColor: inSet ? theme.colors.accent : theme.colors.border,
                        backgroundColor: theme.colors.surface2,
                        opacity: inSet ? 1 : 0.4,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {thumb ? (
                        <Image source={{ uri: thumb }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                      ) : (
                        <Text variant="micro" color="faint">
                          {item?.mediaType === 'video' ? '▶' : '—'}
                        </Text>
                      )}
                    </Pressable>
                  );
                })}
              </View>
              <Button
                variant="secondary"
                title={droppedCount > 0 ? `Remove ${droppedCount} & regenerate` : 'Remove clips & regenerate'}
                onPress={onRemoveRegenerate}
                disabled={!canRemoveRegen}
                loading={starting}
                testID="montage-remove-regenerate"
              />
            </View>
          ) : null}

          {/* ── Regenerate (same set) ──────────────────────────────────────── */}
          {!isPublished ? (
            <Button
              variant="ghost"
              fullWidth
              title="Regenerate"
              onPress={onRegenerate}
              disabled={starting}
              loading={starting}
              testID="montage-regenerate"
            />
          ) : null}

          {/* ── Publish to groups ──────────────────────────────────────────── */}
          {!isPublished ? (
            <View style={{ gap: theme.spacing.base }}>
              <Text variant="micro" color="label">
                Publish to
              </Text>
              {groupsQuery.isLoading ? (
                <Text variant="caption" color="muted">
                  Loading your groups…
                </Text>
              ) : groups.length === 0 ? (
                <Text variant="caption" color="muted">
                  You're not in any groups yet. Create or join one to publish.
                </Text>
              ) : (
                <View style={{ gap: theme.spacing.sm }} testID="montage-group-list">
                  {groups.map((g) => {
                    const sel = selectedGroups.has(g.id);
                    return (
                      <Pressable
                        key={g.id}
                        onPress={() => toggle(selectedGroups, g.id, setSelectedGroups)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: sel }}
                        testID={`group-select-${g.id}`}
                      >
                        <Card variant="compact" flat>
                          <View
                            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.base }}
                          >
                            <View
                              style={{
                                width: 22,
                                height: 22,
                                borderRadius: theme.radii.sm,
                                borderWidth: 2,
                                borderColor: sel ? theme.colors.accent : theme.colors.border,
                                backgroundColor: sel ? theme.colors.accent : 'transparent',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              {sel ? (
                                <Text variant="caption" color="onAccent">
                                  ✓
                                </Text>
                              ) : null}
                            </View>
                            <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>
                              {g.name}
                            </Text>
                            <Text variant="caption" color="muted">
                              {g.memberCount}
                            </Text>
                          </View>
                        </Card>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              <Button
                variant="primary"
                fullWidth
                title={selectedGroups.size > 1 ? `Publish to ${selectedGroups.size} groups` : 'Publish'}
                onPress={onPublish}
                disabled={selectedGroups.size === 0 || publish.isPending}
                loading={publish.isPending}
                testID="montage-publish"
              />
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Screen>
  );
}
