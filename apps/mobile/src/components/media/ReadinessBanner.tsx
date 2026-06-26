// ReadinessBanner — the soft hint that gates M7's "Generate" CTA. Takes the
// readiness() summary over today's items and renders an Ember Card banner:
//   • ready  → success copy "You've got enough to generate your montage" + an
//              ENABLED "Generate" button (M7) wired to the montage generate flow.
//   • !ready → muted hint to add a photo/video (+ pending/checking count if any).
// A stable testID="readiness-state" text node reflects ready/not-ready so the e2e
// can assert the flip. `onGenerate` is supplied by the Today screen (kicks off
// montageStore.startGenerate → navigates to the generating screen).
//
// Web-safe: no expo-camera / expo-image-picker imports.
import { View } from 'react-native';
import { MONTAGE_MIN_MEDIA } from '@twenty4/contracts';
import { Button, Card, Text } from '@/ui';
import { useTheme } from '@/theme';
import type { TodayReadiness } from '@/lib/media';

export function ReadinessBanner({
  readiness,
  onGenerate,
  generating = false,
}: {
  readiness: TodayReadiness;
  /** Kick off the montage generate flow (Today screen → montageStore.startGenerate). */
  onGenerate?: () => void;
  /** The POST /montages is in flight. */
  generating?: boolean;
}) {
  const theme = useTheme();
  const { ready, pendingCount } = readiness;

  return (
    <View testID="readiness-banner">
      <Card variant="compact">
      <View style={{ gap: theme.spacing.base }}>
        <Text variant="caption" color="label">
          {/* stable, machine-assertable state node */}
          <Text variant="caption" color="label" testID="readiness-state">
            {ready ? 'ready' : 'not-ready'}
          </Text>
        </Text>

        {ready ? (
          <>
            <Text variant="body" color="success">
              You’ve got enough — make your recap
            </Text>
            <Button
              variant="primary"
              fullWidth
              title="Generate"
              onPress={onGenerate}
              disabled={!onGenerate || generating}
              loading={generating}
              testID="generate-button"
            />
          </>
        ) : (
          <Text variant="body" color="muted">
            Add at least {MONTAGE_MIN_MEDIA} clips to make today’s recap
            {pendingCount > 0 ? ` · ${pendingCount} checking…` : ''}
          </Text>
        )}
      </View>
      </Card>
    </View>
  );
}
