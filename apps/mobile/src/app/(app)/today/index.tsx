// (app)/today — the Today hub. Two capture entry points (Camera / Import), a soft
// readiness banner, the in-flight local upload list, and the server-side today bucket.
//
// Dedupe hand-off: a local upload card is shown UNLESS it's `done` AND its mediaId is
// already present in the server bucket (by id). Once the server bucket includes the
// uploaded item, its local card drops → gap-free transition (no double-show).
import { useMemo } from 'react';
import { Image, RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, Screen, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { EmptyState, ErrorRetry, ListSkeleton } from '@/components/QueryState';
import { useTodayBucket, readiness } from '@/lib/media';
import { pickFromLibrary } from '@/lib/imagePicker';
import {
  useUploadStore,
  useUploadItems,
  type UploadItem,
} from '@/stores/uploadStore';
import { ReadinessBanner } from '@/components/media/ReadinessBanner';
import { UploadCard } from '@/components/media/UploadCard';
import { TodayItemCard } from '@/components/media/TodayItemCard';
import { useMontage } from '@/lib/montage';
import { useMontageStore, useMontageStarting, useCurrentMontage } from '@/stores/montageStore';

export default function TodayScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();

  const todayQuery = useTodayBucket();
  const uploadItems = useUploadItems();
  const retry = useUploadStore((s) => s.retry);
  const cancel = useUploadStore((s) => s.cancel);
  const clearFinished = useUploadStore((s) => s.clearFinished);

  // M7: kick off the montage render. startGenerate POSTs /montages then navigates
  // to the generating host screen; `starting` drives the button's loading state.
  const startGenerate = useMontageStore((s) => s.startGenerate);
  const generating = useMontageStarting();
  const onGenerate = () => {
    void startGenerate({}).catch(() => {
      toast.show({ type: 'error', message: useMontageStore.getState().error ?? 'Could not start montage' });
    });
  };

  const serverItems = todayQuery.data?.items ?? [];
  const serverIds = useMemo(() => new Set(serverItems.map((it) => it.id)), [serverItems]);

  // M9: once today's recap is PUBLISHED, the Today screen reflects the published
  // state instead of the raw capture grid (the server purges the raw media at the
  // +grace mark; this is purely the UI catching up). We learn the published state
  // from the in-session montage (the store's `current` id → its cached detail). No
  // server list endpoint exists, so this covers the publish → back-to-Today flow;
  // a cold start (no `current`) falls back to the normal grid.
  const current = useCurrentMontage();
  const montageQuery = useMontage(current?.id);
  const todayBucket = todayQuery.data?.dayBucket;
  const publishedMontage =
    current &&
    montageQuery.data?.status === 'published' &&
    !!todayBucket &&
    montageQuery.data.dayBucket === todayBucket
      ? montageQuery.data
      : null;

  // Dedupe: drop a `done` local card once the server bucket already includes its mediaId.
  const visibleUploads = useMemo<UploadItem[]>(
    () =>
      uploadItems.filter(
        (u) => !(u.status === 'done' && u.mediaId != null && serverIds.has(u.mediaId)),
      ),
    [uploadItems, serverIds],
  );

  const hasFinished = uploadItems.some(
    (u) => u.status === 'done' || u.status === 'failed' || u.status === 'canceled',
  );

  const goCamera = () => router.push('/(app)/camera');

  const onImport = async () => {
    let result;
    try {
      result = await pickFromLibrary();
    } catch {
      toast.show({ type: 'error', message: 'Could not open your library.' });
      return;
    }
    const { assets, skipped } = result;
    if (assets.length === 0) {
      // Nothing supported to enqueue — either nothing picked, or every pick was an
      // unsupported type. Surface the skip reason when that's why we're empty.
      toast.show(
        skipped > 0
          ? { type: 'error', message: `Skipped ${skipped} unsupported file${skipped === 1 ? '' : 's'}.` }
          : { type: 'info', message: 'No media added.' },
      );
      return;
    }
    useUploadStore.getState().enqueue(assets);
    toast.show({
      type: 'success',
      message:
        `Uploading ${assets.length} item${assets.length === 1 ? '' : 's'}…` +
        (skipped > 0 ? ` (skipped ${skipped} unsupported)` : ''),
    });
  };

  const onClearFinished = () => {
    clearFinished();
    toast.show({ type: 'info', message: 'Cleared finished uploads' });
  };

  const refreshControl = (
    <RefreshControl
      refreshing={todayQuery.isRefetching}
      onRefresh={() => {
        todayQuery.refetch().catch(() => {
          toast.show({ type: 'error', message: 'Could not refresh' });
        });
      }}
      tintColor={theme.colors.accent}
      colors={[theme.colors.accent]}
    />
  );

  // ── Today bucket body (loading / error / empty / list) ──────────────────────
  const renderTodayBucket = () => {
    if (todayQuery.isLoading) {
      return <ListSkeleton count={3} />;
    }
    if (todayQuery.isError) {
      return (
        <ErrorRetry
          onRetry={() => void todayQuery.refetch()}
          error={todayQuery.error}
          retrying={todayQuery.isFetching}
        />
      );
    }
    if (serverItems.length === 0) {
      return (
        <EmptyState
          title="No captures yet today"
          subtitle="Use Camera to capture a moment, or Import from your library."
        />
      );
    }
    return (
      <View style={{ gap: theme.spacing.base }} testID="today-list">
        {serverItems.map((item) => (
          <TodayItemCard key={item.id} item={item} />
        ))}
      </View>
    );
  };

  return (
    <Screen padded={false}>
      <View style={{ flex: 1 }} testID="today-screen">
      <View style={{ paddingHorizontal: theme.spacing.xl }}>
        <ScreenHeader title="Today" />
      </View>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.base,
          paddingBottom: theme.spacing.section,
          gap: theme.spacing.lg,
        }}
        refreshControl={refreshControl}
        showsVerticalScrollIndicator={false}
      >
        {publishedMontage ? (
          /* Published state — the raw capture grid is intentionally hidden now. */
          <View style={{ gap: theme.spacing.base }} testID="today-published">
            <Card variant="compact">
              <View style={{ gap: theme.spacing.base }}>
                {publishedMontage.thumbnailUrl ? (
                  <Image
                    source={{ uri: publishedMontage.thumbnailUrl }}
                    style={{
                      width: '100%',
                      height: 220,
                      borderRadius: theme.radii.md,
                      backgroundColor: theme.colors.surface2,
                    }}
                    resizeMode="cover"
                    testID="today-published-thumb"
                  />
                ) : null}
                <Text variant="title">Today’s recap is published 🎉</Text>
                <Text variant="caption" color="muted">
                  Your captures from today have been turned into a recap and shared to your group — they’re
                  no longer shown here.
                </Text>
                <Button
                  variant="primary"
                  fullWidth
                  title="View recap"
                  onPress={() => router.push(`/(app)/montage/${publishedMontage.id}`)}
                  testID="today-view-recap"
                />
              </View>
            </Card>
          </View>
        ) : (
          <>
        {/* Capture CTAs */}
        <View style={{ flexDirection: 'row', gap: theme.spacing.base }}>
          <Button
            variant="primary"
            title="Camera"
            onPress={goCamera}
            style={{ flex: 1 }}
            fullWidth
            testID="open-camera-button"
          />
          <Button
            variant="secondary"
            title="Import"
            onPress={() => void onImport()}
            style={{ flex: 1 }}
            fullWidth
            testID="import-media-button"
          />
        </View>

        {/* Soft readiness hint + M7 generate gate */}
        <ReadinessBanner
          readiness={readiness(serverItems)}
          onGenerate={onGenerate}
          generating={generating}
        />

        {/* In-flight local uploads (deduped against the server bucket) */}
        {visibleUploads.length > 0 ? (
          <View style={{ gap: theme.spacing.base }}>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Text variant="micro" color="label">
                Uploading · {visibleUploads.length}
              </Text>
              {hasFinished ? (
                <Button
                  variant="ghost"
                  size="sm"
                  title="Clear finished"
                  onPress={onClearFinished}
                  testID="clear-finished-button"
                />
              ) : null}
            </View>
            <View style={{ gap: theme.spacing.sm }} testID="upload-list">
              {visibleUploads.map((u) => (
                <UploadCard key={u.localId} item={u} onRetry={retry} onCancel={cancel} />
              ))}
            </View>
          </View>
        ) : null}

        {/* Server-side today bucket */}
        <View style={{ gap: theme.spacing.base }}>
          <Text variant="micro" color="label">
            Today’s captures{serverItems.length > 0 ? ` · ${serverItems.length}` : ''}
          </Text>
          {renderTodayBucket()}
        </View>
          </>
        )}
      </ScrollView>
      </View>
    </Screen>
  );
}
