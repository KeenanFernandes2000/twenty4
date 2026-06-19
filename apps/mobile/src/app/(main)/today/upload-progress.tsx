/**
 * Upload progress — the per-item upload tray (one of the 3 undesigned screens;
 * built functionally in Ember). Lists every in-flight/finished upload TASK from
 * the uploadStore with a ProgressBar + status, retry on failure, and a
 * clear-finished action.
 *
 * Web screenshot path: `EXPO_PUBLIC_MOCK_TODAY` seeds the store-shaped MOCK tray
 * so this screen renders populated without a device/session.
 *
 * Web-safe: the retry handler imports the upload runner lazily so the native
 * transfer module is never pulled onto a web-reachable path at module load.
 */
import { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../../../theme';
import { Button, EmptyState, Icon } from '../../../ui';
import { UploadTaskRow } from '../../../components/UploadTaskRow';
import { useUploadStore, type UploadTask } from '../../../stores/uploadStore';
import { mockMode, MOCK_UPLOAD_TASKS } from '../../../lib/mediaMocks';

export default function UploadProgress() {
  const theme = useTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();

  const mock = mockMode();
  const useMock = mock !== 'off';

  const order = useUploadStore((s) => s.order);
  const tasksMap = useUploadStore((s) => s.tasks);
  const remove = useUploadStore((s) => s.remove);
  const clearFinished = useUploadStore((s) => s.clearFinished);

  const tasks: UploadTask[] = useMemo(() => {
    if (useMock) return MOCK_UPLOAD_TASKS;
    return order.map((id) => tasksMap[id]).filter(Boolean);
  }, [useMock, order, tasksMap]);

  const onRetry = (localId: string) => {
    // Lazy import keeps the native transfer module off the web-reachable path.
    void import('../../../lib/upload').then((m) => m.retryUpload(localId));
  };

  const hasFinished = tasks.some((t) => t.status === 'done' || t.status === 'failed');
  const active = tasks.filter((t) => t.status === 'queued' || t.status === 'uploading').length;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{
        paddingTop: theme.spacing.lg,
        paddingBottom: insets.bottom + theme.spacing.xl,
        paddingHorizontal: theme.spacing.lg,
        gap: theme.spacing.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="cloud-upload-outline" size={18} color={c.accent} />
        <Text style={{ ...theme.typography.subheading, color: c.text, flex: 1 }}>
          {active > 0 ? `${active} uploading` : 'Uploads'}
        </Text>
        {hasFinished && !useMock ? (
          <Button label="Clear done" variant="ghost" size="sm" onPress={clearFinished} />
        ) : null}
      </View>

      {tasks.length === 0 ? (
        <View style={{ marginTop: theme.spacing.xl }}>
          <EmptyState
            icon="cloud-done-outline"
            title="Nothing uploading"
            body="Captures and library picks show their progress here while they upload in the background."
          />
        </View>
      ) : (
        tasks.map((task) => (
          <UploadTaskRow
            key={task.localId}
            task={task}
            onRetry={onRetry}
            onRemove={useMock ? undefined : remove}
          />
        ))
      )}
    </ScrollView>
  );
}
