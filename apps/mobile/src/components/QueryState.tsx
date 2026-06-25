// QueryState — generic, theme-styled building blocks every screen reuses to render
// the loading / empty / error states of a react-query view. Pure presentational
// (no data fetching here); screens pass in handlers. Ember-styled.
//
// Exports:
//   <ListSkeleton count? />            shimmer-ish placeholder rows for a list load
//   <DetailSkeleton />                 placeholder for a single detail screen
//   <ErrorRetry onRetry error? />      friendly error panel + Retry button (+ OfflineHint)
//   <EmptyState title subtitle? action? icon? />  empty list / no-data panel
//   <OfflineHint visible />            small inline "looks offline" banner
//   isNetworkError(err)                best-effort: does this query error look like a
//                                      transport/network failure (vs an API error)?
import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import { ApiError } from '@twenty4/api-client';
import { Button, Card, Text } from '@/ui';
import { useTheme } from '@/theme';

// ── Network-error inference ──────────────────────────────────────────────────
// We deliberately do NOT depend on @react-native-community/netinfo (keeps the web
// export clean). Instead we infer "offline-ish" from the query error itself: a
// thrown ApiError means the server answered (it has an HTTP status) → NOT a network
// failure. Anything else (TypeError "Failed to fetch", AbortError, generic Error
// with no status) is treated as a probable transport problem.
export function isNetworkError(err: unknown): boolean {
  if (err == null) return false;
  if (err instanceof ApiError) return false; // server responded with a coded error
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('failed to fetch') ||
      msg.includes('fetch failed') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('connection') ||
      msg.includes('unreachable') ||
      err.name === 'AbortError' ||
      err.name === 'TypeError'
    );
  }
  return false;
}

// ── Skeletons ────────────────────────────────────────────────────────────────

function SkeletonBlock({
  width,
  height,
  radius,
}: {
  width: ViewStyle['width'];
  height: number;
  radius?: number;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        width,
        height,
        borderRadius: radius ?? theme.radii.sm,
        backgroundColor: theme.colors.surface2,
        opacity: 0.6,
      }}
    />
  );
}

function SkeletonRow() {
  const theme = useTheme();
  return (
    <Card variant="compact" flat>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.base }}>
        <SkeletonBlock width={44} height={44} radius={theme.radii.full} />
        <View style={{ flex: 1, gap: theme.spacing.sm }}>
          <SkeletonBlock width="60%" height={14} />
          <SkeletonBlock width="35%" height={11} />
        </View>
      </View>
    </Card>
  );
}

export function ListSkeleton({ count = 5 }: { count?: number }) {
  const theme = useTheme();
  return (
    <View
      style={{ gap: theme.spacing.base }}
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
    >
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </View>
  );
}

export function DetailSkeleton() {
  const theme = useTheme();
  return (
    <View
      style={{ gap: theme.spacing.xl, paddingVertical: theme.spacing.xl }}
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
    >
      <View style={{ alignItems: 'center', gap: theme.spacing.base }}>
        <SkeletonBlock width={64} height={64} radius={theme.radii.full} />
        <SkeletonBlock width="50%" height={22} />
        <SkeletonBlock width="30%" height={12} />
      </View>
      <View style={{ gap: theme.spacing.base }}>
        <SkeletonBlock width="100%" height={56} radius={theme.radii.lg} />
        <SkeletonBlock width="100%" height={56} radius={theme.radii.lg} />
        <SkeletonBlock width="100%" height={56} radius={theme.radii.lg} />
      </View>
    </View>
  );
}

// ── Offline hint ─────────────────────────────────────────────────────────────

export function OfflineHint({ visible }: { visible: boolean }) {
  const theme = useTheme();
  if (!visible) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        backgroundColor: theme.colors.surface2,
        borderRadius: theme.radii.lg,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingVertical: theme.spacing.base,
        paddingHorizontal: theme.spacing.lg,
      }}
    >
      <Text variant="caption" color="muted" style={{ flex: 1 }}>
        You appear to be offline. Check your connection and try again.
      </Text>
    </View>
  );
}

// ── Error + retry ────────────────────────────────────────────────────────────

export function ErrorRetry({
  onRetry,
  error,
  title,
  message,
  retrying = false,
}: {
  onRetry: () => void;
  error?: unknown;
  /** Override the heading. Default "Something went wrong". */
  title?: string;
  /** Override the body copy. Default derived from the error. */
  message?: string;
  retrying?: boolean;
}) {
  const theme = useTheme();
  const offline = isNetworkError(error);
  const body =
    message ??
    (offline
      ? "We couldn't reach the server."
      : 'We hit a snag loading this. Please try again.');

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.xl,
        paddingVertical: theme.spacing.huge,
      }}
    >
      <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
        <Text variant="title" align="center">
          {title ?? 'Something went wrong'}
        </Text>
        <Text variant="body" color="muted" align="center">
          {body}
        </Text>
      </View>
      <OfflineHint visible={offline} />
      <Button
        variant="secondary"
        title="Try again"
        loading={retrying}
        onPress={onRetry}
        testID="error-retry-button"
      />
    </View>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

export function EmptyState({
  title,
  subtitle,
  action,
  icon,
}: {
  title: string;
  subtitle?: string;
  /** A primary CTA (or any node). */
  action?: ReactNode;
  /** Optional decorative node above the title (e.g. an emoji Text). */
  icon?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.xl,
        paddingVertical: theme.spacing.huge,
        paddingHorizontal: theme.spacing.xl,
      }}
      testID="empty-state"
    >
      {icon != null ? <View>{icon}</View> : null}
      <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
        <Text variant="title" align="center">
          {title}
        </Text>
        {subtitle != null ? (
          <Text variant="body" color="muted" align="center">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action != null ? <View style={{ width: '100%', gap: theme.spacing.base }}>{action}</View> : null}
    </View>
  );
}
