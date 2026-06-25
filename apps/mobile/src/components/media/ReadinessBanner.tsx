// ReadinessBanner — the soft hint that will gate M7's "Generate" CTA. Takes the
// readiness() summary over today's items and renders an Ember Card banner:
//   • ready  → success copy "You've got enough to generate your montage" + a DISABLED
//              "Generate (soon)" placeholder (M7 owns the real action).
//   • !ready → muted hint to add a photo/video (+ pending/checking count if any).
// A stable testID="readiness-state" text node reflects ready/not-ready so the e2e
// can assert the flip.
//
// Web-safe: no expo-camera / expo-image-picker imports.
import { View } from 'react-native';
import { Button, Card, Text } from '@/ui';
import { useTheme } from '@/theme';
import type { TodayReadiness } from '@/lib/media';

export function ReadinessBanner({ readiness }: { readiness: TodayReadiness }) {
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
              You’ve got enough to generate your montage
            </Text>
            <Button
              variant="primary"
              fullWidth
              title="Generate (soon)"
              disabled
              testID="generate-button"
            />
          </>
        ) : (
          <Text variant="body" color="muted">
            Add at least one photo or video to generate
            {pendingCount > 0 ? ` · ${pendingCount} checking…` : ''}
          </Text>
        )}
      </View>
      </Card>
    </View>
  );
}
