/**
 * UploadTaskRow — one in-flight upload in the tray (queued/uploading/done/failed)
 * with a per-item ProgressBar and a retry/remove affordance. Pure presentational
 * (the upload-progress screen passes handlers), so it is web-renderable for the
 * screenshot. Ember-themed; no native imports.
 */
import { Text, View } from 'react-native';

import { useTheme } from '../theme';
import { Button, Icon, ProgressBar, type IconName } from '../ui';
import type { UploadStatus, UploadTask } from '../stores/uploadStore';

const STATUS_META: Record<
  UploadStatus,
  { icon: IconName; label: string; tone: 'accent' | 'success' | 'danger' | 'muted' }
> = {
  queued: { icon: 'time-outline', label: 'Queued', tone: 'muted' },
  uploading: { icon: 'cloud-upload-outline', label: 'Uploading', tone: 'accent' },
  done: { icon: 'checkmark-circle', label: 'Uploaded', tone: 'success' },
  failed: { icon: 'alert-circle', label: 'Failed', tone: 'danger' },
};

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export interface UploadTaskRowProps {
  task: UploadTask;
  onRetry?: (localId: string) => void;
  onRemove?: (localId: string) => void;
}

export function UploadTaskRow({ task, onRetry, onRemove }: UploadTaskRowProps) {
  const theme = useTheme();
  const c = theme.colors;
  const meta = STATUS_META[task.status];
  const toneColor =
    meta.tone === 'accent'
      ? c.accent
      : meta.tone === 'success'
        ? c.success
        : meta.tone === 'danger'
          ? c.danger
          : c.muted;

  return (
    <View
      style={{
        backgroundColor: c.surface,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: theme.radii.lg,
        padding: theme.spacing.md,
        gap: theme.spacing.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: theme.radii.md,
            backgroundColor: c.surface2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon
            name={task.meta.mediaType === 'video' ? 'videocam' : 'image'}
            size={18}
            color={c.muted}
          />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ ...theme.typography.bodyStrong, color: c.text }} numberOfLines={1}>
            {task.label}
          </Text>
          <Text style={{ ...theme.typography.caption, color: c.muted }} numberOfLines={1}>
            {formatBytes(task.meta.sizeBytes)}
            {task.meta.capturedInApp ? ' · in-app' : ''}
            {task.attempt > 0 ? ` · retry ${task.attempt}` : ''}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Icon name={meta.icon} size={16} color={toneColor} />
          <Text style={{ ...theme.typography.caption, color: toneColor }}>{meta.label}</Text>
        </View>
      </View>

      {task.status !== 'done' ? (
        <ProgressBar
          value={task.status === 'failed' ? task.progress : task.progress}
          color={task.status === 'failed' ? c.danger : c.accent}
        />
      ) : null}

      {task.status === 'failed' && task.error ? (
        <Text style={{ ...theme.typography.caption, color: c.danger }} numberOfLines={2}>
          {task.error}
        </Text>
      ) : null}

      {task.status === 'failed' && onRetry ? (
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
          <Button label="Retry" icon="refresh" size="sm" onPress={() => onRetry(task.localId)} />
          {onRemove ? (
            <Button
              label="Remove"
              variant="ghost"
              size="sm"
              onPress={() => onRemove(task.localId)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
