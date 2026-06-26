// (app)/montage/[id] — the montage HOST screen (M7 §9.2 + §9 missing-design).
//
// One route, state-driven by the polled montage status (the clean-routing option
// the spec endorses):
//   • generating          → progress/indeterminate screen (Cancel → Today)
//   • failed              → retryable error + Retry (re-regenerate)
//   • draft_ready / published → the review screen (<MontageReview/>)
//   • deleted/expired     → a graceful "no longer available" terminal
//
// Polling lives in @/lib/montage (useMontage stops once the render settles). We
// mirror the freshest status back into the montage store so the Today CTA / the
// store's `current` stay in sync.
import { useEffect } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { MontageStatus } from '@twenty4/contracts';
import { Button, Screen, Spinner, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { ErrorRetry } from '@/components/QueryState';
import { useMontage } from '@/lib/montage';
import { useMontageStore, useMontageStarting } from '@/stores/montageStore';
import { MontageReview } from '@/components/montage/MontageReview';

const TERMINAL_GONE: MontageStatus[] = ['deleted_by_user', 'removed_by_admin', 'expired'];

export default function MontageHostScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();

  const montageQuery = useMontage(id);
  const syncStatus = useMontageStore((s) => s.syncStatus);
  const regenerate = useMontageStore((s) => s.regenerate);
  const clear = useMontageStore((s) => s.clear);
  const starting = useMontageStarting();

  const montage = montageQuery.data;
  const status = montage?.status;

  // Keep the store's `current` status in lockstep with the poll.
  useEffect(() => {
    if (id && status) syncStatus(id, status);
  }, [id, status, syncStatus]);

  const goToday = () => {
    clear();
    router.replace('/(app)/today');
  };

  const onRetry = () => {
    if (!id) return;
    regenerate(id).catch(() => {
      toast.show({ type: 'error', message: useMontageStore.getState().error ?? 'Could not retry' });
    });
  };

  // ── Query error (e.g. montage not found / not owned) ─────────────────────────
  if (montageQuery.isError) {
    return (
      <Screen>
        <ScreenHeader title="Your montage" onBack={goToday} />
        <ErrorRetry
          onRetry={() => void montageQuery.refetch()}
          error={montageQuery.error}
          retrying={montageQuery.isFetching}
        />
      </Screen>
    );
  }

  // ── Review (draft_ready / published) ─────────────────────────────────────────
  if (montage && (status === 'draft_ready' || status === 'published')) {
    return <MontageReview montage={montage} />;
  }

  // ── Failed (retryable) ───────────────────────────────────────────────────────
  if (status === 'failed') {
    return (
      <Screen>
        <ScreenHeader title="Your montage" onBack={goToday} />
        <View
          testID="montage-failed"
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.xl }}
        >
          <Text variant="title" align="center">
            Montage render failed
          </Text>
          <Text variant="body" color="muted" align="center">
            {montage?.error ?? 'Something went wrong while rendering. You can try again.'}
          </Text>
          <View style={{ width: '100%', gap: theme.spacing.base }}>
            <Button
              variant="primary"
              fullWidth
              title="Try again"
              onPress={onRetry}
              loading={starting}
              testID="montage-retry"
            />
            <Button variant="secondary" fullWidth title="Back to Today" onPress={goToday} testID="montage-cancel" />
          </View>
        </View>
      </Screen>
    );
  }

  // ── Terminal "gone" states (reserved for M8/M9) ──────────────────────────────
  if (status && TERMINAL_GONE.includes(status)) {
    return (
      <Screen>
        <ScreenHeader title="Your montage" onBack={goToday} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.xl }}>
          <Text variant="title" align="center">
            This montage is no longer available
          </Text>
          <Button variant="secondary" fullWidth title="Back to Today" onPress={goToday} testID="montage-cancel" />
        </View>
      </Screen>
    );
  }

  // ── Generating / progress (default; covers first-load + status==='generating') ─
  return (
    <Screen>
      <ScreenHeader title="Your montage" onBack={goToday} />
      <View
        testID="montage-generating"
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.xl }}
      >
        <View testID="montage-progress" style={{ alignItems: 'center', gap: theme.spacing.lg }}>
          <Spinner size="large" />
          <Text variant="title" align="center">
            Building your montage…
          </Text>
          <Text variant="body" color="muted" align="center">
            We're cutting your photos and videos to the beat. This usually takes about a minute and a half — keep the
            app open.
          </Text>
        </View>
        <Button variant="secondary" fullWidth title="Cancel" onPress={goToday} testID="montage-cancel" />
      </View>
    </Screen>
  );
}
