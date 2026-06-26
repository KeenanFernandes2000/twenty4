// TodayItemCard — renders ONE server-side MediaItemDTO from the today bucket.
// Thumbnail from downloadUrl (only non-null once valid → otherwise a neutral
// placeholder tile, so pending/invalid items never show a broken image), a small
// validation badge, video duration, and a confirm-gated Remove button wired to the
// optimistic useDeleteMedia mutation.
//
// Web-safe: no expo-camera / expo-image-picker imports.
import { Image, View } from 'react-native';
import { Button, Card, Text } from '@/ui';
import type { TextColor } from '@/ui';
import { useTheme } from '@/theme';
import { confirm } from '@/lib/confirm';
import { useDeleteMedia } from '@/lib/media';
import { useToast } from '@/ui';
import type { MediaItemDTO } from '@twenty4/contracts';

const BADGE: Record<MediaItemDTO['validationStatus'], { label: string; color: TextColor }> = {
  pending: { label: 'Checking…', color: 'muted' },
  valid: { label: 'Ready', color: 'success' },
  invalid: { label: 'Rejected', color: 'danger' },
};

function formatDuration(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function TodayItemCard({ item }: { item: MediaItemDTO }) {
  const theme = useTheme();
  const toast = useToast();
  const del = useDeleteMedia();

  const isVideo = item.mediaType === 'video';
  const badge = BADGE[item.validationStatus];
  const duration = isVideo ? formatDuration(item.durationMs) : null;
  // PHOTO: show a real image once we have a signed URL (valid item). VIDEO: never feed
  // the raw .mp4/.mov downloadUrl to <Image> (it can't decode it → blank tile); render
  // an intentional dark play-tile instead, consistent with UploadCard/CaptureThumbStrip.
  // (Real poster frames are a tracked server-side follow-up.)
  const hasThumb = !isVideo && item.downloadUrl != null;

  const onRemove = async () => {
    const ok = await confirm({
      title: 'Remove this capture?',
      message: 'It will be removed from today’s bucket. This can’t be undone.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    del.mutate(item.id, {
      onSuccess: () => toast.show({ type: 'success', message: 'Removed' }),
      onError: () => toast.show({ type: 'error', message: 'Could not remove. Please try again.' }),
    });
  };

  return (
    <View testID="today-item">
      <Card variant="compact" flat>
      <View style={{ gap: theme.spacing.base }}>
        {/* Thumbnail / placeholder tile */}
        <View
          style={{
            width: '100%',
            aspectRatio: 1,
            borderRadius: theme.radii.md,
            overflow: 'hidden',
            backgroundColor: theme.colors.surface2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {isVideo ? (
            <>
              {/* VIDEO: intentional dark play-tile (no poster frame yet) — full-cover
                  scrim + centered play glyph, matching UploadCard/CaptureThumbStrip. */}
              <View
                style={{
                  position: 'absolute',
                  inset: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.colors.scrim,
                }}
              >
                <Text variant="display" color="onAccent">
                  {'▶'}
                </Text>
              </View>
              {/* Duration badge (relocated here off the centered glyph). */}
              <View
                style={{
                  position: 'absolute',
                  top: theme.spacing.xs,
                  right: theme.spacing.xs,
                  paddingHorizontal: theme.spacing.sm,
                  paddingVertical: theme.spacing.xxs,
                  borderRadius: theme.radii.sm,
                  backgroundColor: theme.colors.scrim,
                }}
              >
                <Text variant="micro" color="onAccent">
                  {duration ?? 'Video'}
                </Text>
              </View>
            </>
          ) : hasThumb ? (
            <Image
              source={{ uri: item.downloadUrl as string }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="cover"
            />
          ) : (
            <Text variant="caption" color="faint">
              {item.validationStatus === 'invalid' ? 'Unavailable' : 'Processing…'}
            </Text>
          )}
        </View>

        {/* Status badge + remove */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Text variant="caption" color={badge.color} testID="today-item-status" style={{ flex: 1 }}>
            {badge.label}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            title="Remove"
            onPress={() => void onRemove()}
            loading={del.isPending}
            testID="today-item-remove"
          />
        </View>
      </View>
      </Card>
    </View>
  );
}
