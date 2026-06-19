/**
 * 5.5 Blocked users — the caller's blocked list (GET /blocks), newest-first.
 *
 * Each row: avatar + name/@handle + an "Unblock" button (DELETE /blocks/:userId,
 * idempotent). Unblocking refreshes the feed (the user's recaps can reappear) and
 * the list. Loading skeletons, an error+retry, and an empty state.
 *
 * Web-safe: the real query runs on a device; the web export renders the SAME
 * screen against lib/safetyMocks (globalThis.__TWENTY4_SAFETY_MOCK__) so the
 * orchestrator can screenshot the populated + empty states in light/dark.
 */
import { useCallback, useState } from 'react';
import { Stack } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';

import { useTheme } from '../../../theme';
import { Avatar, Button, Card, EmptyState, ErrorRetry, Skeleton, Toast } from '../../../ui';
import type { UserSummary } from '@twenty4/contracts/dto';
import {
  safetyErrorMessage,
  useBlockedUsers,
  useUnblockUser,
} from '../../../lib/safety';

function BlockedRow({
  user,
  onUnblocked,
}: {
  user: UserSummary;
  onUnblocked: (name: string) => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const unblock = useUnblockUser();

  const onPress = useCallback(async () => {
    try {
      await unblock.mutateAsync(user.id);
      onUnblocked(user.displayName);
    } catch {
      // The list refetches on success; a failure leaves the row in place.
    }
  }, [unblock, user.id, user.displayName, onUnblocked]);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: theme.spacing.lg,
      }}
    >
      <Avatar name={user.displayName} uri={user.profilePhotoUrl ?? undefined} size={42} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.text, fontFamily: theme.fontFamily.semibold, fontSize: 15 }}>
          {user.displayName}
        </Text>
        <Text style={{ color: c.muted, fontFamily: theme.fontFamily.regular, fontSize: 13 }}>
          @{user.username}
        </Text>
      </View>
      <Button
        label="Unblock"
        variant="secondary"
        size="sm"
        loading={unblock.isPending}
        onPress={() => void onPress()}
      />
    </View>
  );
}

export default function BlockedUsers() {
  const theme = useTheme();
  const c = theme.colors;
  const query = useBlockedUsers();
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((name: string) => {
    setToast(`You unblocked ${name}.`);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const items = query.data?.items ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: 'Blocked' }} />

      {toast ? (
        <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md }}>
          <Toast message={toast} tone="success" />
        </View>
      ) : null}

      {query.isLoading ? (
        <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Skeleton width={42} height={42} radius={21} />
              <View style={{ gap: 6, flex: 1 }}>
                <Skeleton width={140} height={14} />
                <Skeleton width={90} height={11} />
              </View>
              <Skeleton width={78} height={32} radius={theme.radii.md} />
            </View>
          ))}
        </View>
      ) : query.isError ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <ErrorRetry
            message={safetyErrorMessage(query.error)}
            onRetry={() => void query.refetch()}
          />
        </View>
      ) : items.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <EmptyState
            icon="ban-outline"
            title="No one's blocked"
            body="When you block someone, they show up here. You can unblock them anytime."
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}
        >
          <Text style={{ ...theme.typography.caption, color: c.muted, marginBottom: theme.spacing.xs }}>
            Blocked people can't see your recaps, and you won't see theirs.
          </Text>
          <Card padded={false}>
            {items.map((user, i) => (
              <View key={user.id}>
                {i > 0 ? <View style={{ height: 1, backgroundColor: c.border }} /> : null}
                <BlockedRow user={user} onUnblocked={showToast} />
              </View>
            ))}
          </Card>
        </ScrollView>
      )}
    </View>
  );
}
