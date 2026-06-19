/**
 * 2.1 Today — the day's collected-media grid.
 *
 * - GET /media/today (React Query, `useTodayMedia`) → 9:16 tiles + validCount.
 *   On web export with `EXPO_PUBLIC_MOCK_TODAY` set, renders mock data instead so
 *   the grid/empty-state can be screenshotted without a device/session.
 * - Header: a "today" title + a CountdownBadge to the next 4am close (the bucket
 *   rollover, §6 Q3) + a valid-count summary.
 * - Capture/add CTA: opens 2.2 camera (native) or 2.3 gallery (native); on web
 *   these are guarded (the buttons route, but the target screens render a
 *   "device-only" notice).
 * - An upload-tray banner appears while uploads are in flight (links to the
 *   upload-progress screen).
 * - Empty state when the bucket has no items.
 *
 * Web-safe: no native-only imports; capture entry points are router pushes.
 */
import { useMemo } from 'react';
import { Alert, Platform, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { useTheme } from '../../../theme';
import { Button, CountdownBadge, EmptyState, ErrorRetry, Icon, Skeleton } from '../../../ui';
import { MediaTile } from '../../../components/MediaTile';
import { useDeleteMedia, useTodayMedia, mediaErrorMessage } from '../../../lib/media';
import { nextDayClose } from '../../../lib/dayClose';
import { mockMode, mockToday } from '../../../lib/mediaMocks';
import { useUploadStore, selectActiveCount } from '../../../stores/uploadStore';
import type { MediaItemResponse, TodayMediaResponse } from '@twenty4/contracts/dto';

const GRID_GAP = 8;
const COLS = 3;

export default function Today() {
  const theme = useTheme();
  const c = theme.colors;
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Web screenshot path: serve mock data, skip the real query.
  const mock = mockMode();
  const useMock = mock !== 'off';

  const query = useTodayMedia({ enabled: !useMock });
  const deleteMedia = useDeleteMedia();

  const activeUploads = useUploadStore(selectActiveCount);
  const uploadOrder = useUploadStore((s) => s.order);

  const data: TodayMediaResponse | undefined = useMock ? mockToday(mock) ?? undefined : query.data;
  const isLoading = !useMock && query.isLoading;
  const isError = !useMock && query.isError;

  const closeAt = useMemo(() => nextDayClose(), []);

  const onAdd = () => {
    if (Platform.OS === 'web') {
      router.push('/(main)/today/gallery');
      return;
    }
    router.push('/(main)/today/gallery');
  };
  const onCamera = () => router.push('/(main)/today/camera');

  const onDelete = (item: MediaItemResponse) => {
    const doDelete = () => deleteMedia.mutate(item.id);
    if (Platform.OS === 'web') {
      doDelete();
      return;
    }
    Alert.alert('Delete this moment?', 'It will be removed from today permanently.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: doDelete },
    ]);
  };

  const items = data?.items ?? [];
  const validCount = data?.validCount ?? 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + theme.spacing.lg,
        paddingBottom: insets.bottom + 120,
        paddingHorizontal: theme.spacing.lg,
        gap: theme.spacing.lg,
      }}
      refreshControl={
        useMock ? undefined : (
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} tintColor={c.accent} />
        )
      }
    >
      {/* Header */}
      <View style={{ gap: theme.spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ ...theme.typography.display, color: c.text }}>Today</Text>
          <CountdownBadge expiresAt={closeAt} />
        </View>
        <Text style={{ ...theme.typography.body, color: c.muted }}>
          Collect today’s moments. They vanish at 4am — your montage is built from what’s here.
        </Text>
        {items.length > 0 ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="checkmark-circle" size={15} color={c.success} />
            <Text style={{ ...theme.typography.caption, color: c.text2 }}>
              {validCount} valid · {items.length} collected
            </Text>
          </View>
        ) : null}
      </View>

      {/* Upload tray banner */}
      {uploadOrder.length > 0 ? (
        <Pressable
          onPress={() => router.push('/(main)/today/upload-progress')}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            backgroundColor: c.accentSoft,
            borderColor: c.border,
            borderWidth: 1,
            borderRadius: theme.radii.lg,
            padding: theme.spacing.md,
          }}
        >
          <Icon name="cloud-upload-outline" size={20} color={c.accent} />
          <Text style={{ ...theme.typography.bodyStrong, color: c.text, flex: 1 }}>
            {activeUploads > 0
              ? `Uploading ${activeUploads} item${activeUploads > 1 ? 's' : ''}…`
              : 'Upload activity'}
          </Text>
          <Icon name="chevron-forward" size={18} color={c.muted} />
        </Pressable>
      ) : null}

      {/* Capture CTA */}
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Button label="Camera" icon="camera" onPress={onCamera} fullWidth />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Add from library" icon="images" variant="secondary" onPress={onAdd} fullWidth />
        </View>
      </View>

      {/* Body */}
      {isLoading ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <View key={i} style={{ width: `${100 / COLS}%`, padding: GRID_GAP / 2 }}>
              <Skeleton width="100%" height={150} radius={theme.radii.lg} />
            </View>
          ))}
        </View>
      ) : isError ? (
        <ErrorRetry message={mediaErrorMessage(query.error)} onRetry={() => query.refetch()} />
      ) : items.length === 0 ? (
        <View style={{ marginTop: theme.spacing.xl }}>
          <EmptyState
            icon="images-outline"
            title="No moments yet"
            body="Capture or add today’s photos and videos. Your 30-second montage builds from what you collect."
            actionLabel="Open camera"
            onAction={onCamera}
          />
        </View>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -GRID_GAP / 2 }}>
          {items.map((item) => (
            <View key={item.id} style={{ width: `${100 / COLS}%`, padding: GRID_GAP / 2 }}>
              <MediaTile item={item} onDelete={onDelete} />
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
