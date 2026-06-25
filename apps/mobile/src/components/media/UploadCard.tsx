// UploadCard — renders ONE local UploadItem (an in-flight / finished client upload).
// Thumbnail from the asset's local uri (works on native file:// and web blob:/data:),
// a kind label, an Ember progress bar (track + accent fill at progress*100%), a status
// row, and contextual controls (Cancel while in-flight, Retry on failed/canceled).
//
// No expo-camera / expo-image-picker imports here — this is rendered eagerly by the
// web today screen, so it must stay web-safe.
import { Image, View } from 'react-native';
import { Button, Card, Spinner, Text } from '@/ui';
import { useTheme } from '@/theme';
import type { UploadItem } from '@/stores/uploadStore';

const STATUS_LABEL: Record<UploadItem['status'], string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  completing: 'Finishing…',
  done: 'Uploaded ✓',
  failed: 'Failed',
  canceled: 'Canceled',
};

export function UploadCard({
  item,
  onRetry,
  onCancel,
}: {
  item: UploadItem;
  onRetry: (localId: string) => void;
  onCancel: (localId: string) => void;
}) {
  const theme = useTheme();

  const isVideo = item.asset.mediaType === 'video';
  const inFlight =
    item.status === 'queued' || item.status === 'uploading' || item.status === 'completing';
  const canRetry = item.status === 'failed' || item.status === 'canceled';

  const pct = Math.round(Math.min(1, Math.max(0, item.progress)) * 100);
  const statusText =
    item.status === 'uploading' ? `Uploading ${pct}%` : STATUS_LABEL[item.status];

  const statusColor =
    item.status === 'done'
      ? 'success'
      : item.status === 'failed'
        ? 'danger'
        : item.status === 'canceled'
          ? 'muted'
          : 'secondary';

  return (
    <View testID="upload-card">
      <Card variant="compact" flat>
      <View style={{ flexDirection: 'row', gap: theme.spacing.base, alignItems: 'center' }}>
        {/* Thumbnail tile */}
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: theme.radii.md,
            overflow: 'hidden',
            backgroundColor: theme.colors.surface2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Image
            source={{ uri: item.asset.uri }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
          {isVideo ? (
            <View
              style={{
                position: 'absolute',
                inset: 0,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.colors.scrim,
              }}
            >
              <Text variant="body" color="onAccent">
                {'▶'}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Body: kind + progress + status */}
        <View style={{ flex: 1, gap: theme.spacing.xs }}>
          <Text variant="label" color="muted">
            {isVideo ? 'Video' : 'Photo'}
          </Text>

          {/* Progress bar: track + fill at progress*100%. */}
          <View
            style={{
              height: 6,
              borderRadius: theme.radii.pill,
              backgroundColor: theme.colors.surface3,
              overflow: 'hidden',
            }}
          >
            <View
              testID="upload-progress"
              style={{
                height: '100%',
                width: `${item.status === 'done' ? 100 : pct}%`,
                borderRadius: theme.radii.pill,
                backgroundColor:
                  item.status === 'failed' || item.status === 'canceled'
                    ? theme.colors.surface3
                    : item.status === 'done'
                      ? theme.colors.success
                      : theme.colors.accent,
              }}
            />
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
            {inFlight ? <Spinner size="small" color={theme.colors.accent} /> : null}
            <Text variant="caption" color={statusColor} testID="upload-status" style={{ flex: 1 }}>
              {item.status === 'failed' && item.error ? item.error : statusText}
            </Text>
          </View>
        </View>

        {/* Controls */}
        <View style={{ gap: theme.spacing.xs }}>
          {inFlight ? (
            <Button
              variant="ghost"
              size="sm"
              title="Cancel"
              onPress={() => onCancel(item.localId)}
              testID="upload-cancel"
            />
          ) : null}
          {canRetry ? (
            <Button
              variant="secondary"
              size="sm"
              title="Retry"
              onPress={() => onRetry(item.localId)}
              testID="upload-retry"
            />
          ) : null}
        </View>
      </View>
      </Card>
    </View>
  );
}
