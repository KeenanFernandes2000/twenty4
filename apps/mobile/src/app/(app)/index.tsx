// (app)/index — Groups home. Lists the caller's active group memberships, with a
// primary "New group" CTA and a secondary "Join" CTA. Empty / loading / error
// states via the generic QueryState components. Pull-to-refresh. A small sign-out
// affordance lives in the header (clear() → AuthGate redirects to welcome).
//
// Deep-link resume: if the user followed an invite link while logged out, the code
// was stashed (pendingInvite). On first mount here (now authenticated) we consume it
// once and bounce to the deep-link route so the invite "resumes".
import { useEffect } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Screen, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useAuthStore } from '@/stores/authStore';
import { consumePendingInvite } from '@/lib/pendingInvite';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { GroupRow } from '@/components/groups/GroupBits';
import { EmptyState, ErrorRetry, ListSkeleton } from '@/components/QueryState';

export default function GroupsHomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();

  // Resume a pending deep-linked invite once we land here authenticated.
  useEffect(() => {
    const code = consumePendingInvite();
    if (code) router.replace(`/invites/${code}`);
  }, [router]);

  const groupsQuery = useQuery({
    queryKey: queryKeys.groups.list,
    queryFn: () => api.listGroups(),
  });

  const signOut = () => {
    void useAuthStore.getState().clear();
  };

  const goNew = () => router.push('/(app)/groups/new');
  const goJoin = () => router.push('/(app)/join');
  const goToday = () => router.push('/(app)/today');
  const goFeed = () => router.push('/(app)/feed');

  const headerRight = (
    <Button
      variant="ghost"
      size="sm"
      title="Sign out"
      onPress={signOut}
      testID="sign-out-button"
    />
  );

  // ── Loading ────────────────────────────────────────────────────────────────
  if (groupsQuery.isLoading) {
    return (
      <Screen>
        <ScreenHeader title="Groups" back={false} right={headerRight} />
        <View style={{ paddingTop: theme.spacing.base }}>
          <ListSkeleton count={4} />
        </View>
      </Screen>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (groupsQuery.isError) {
    return (
      <Screen>
        <ScreenHeader title="Groups" back={false} right={headerRight} />
        <ErrorRetry
          onRetry={() => void groupsQuery.refetch()}
          error={groupsQuery.error}
          retrying={groupsQuery.isFetching}
        />
      </Screen>
    );
  }

  const groups = groupsQuery.data ?? [];
  const refreshControl = (
    <RefreshControl
      refreshing={groupsQuery.isRefetching}
      onRefresh={() => {
        groupsQuery.refetch().catch(() => {
          toast.show({ type: 'error', message: 'Could not refresh' });
        });
      }}
      tintColor={theme.colors.accent}
      colors={[theme.colors.accent]}
    />
  );

  // ── Empty ──────────────────────────────────────────────────────────────────
  if (groups.length === 0) {
    return (
      <Screen padded={false}>
        <View style={{ paddingHorizontal: theme.spacing.xl }}>
          <ScreenHeader title="Groups" back={false} right={headerRight} />
        </View>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, paddingHorizontal: theme.spacing.xl }}
          refreshControl={refreshControl}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ paddingTop: theme.spacing.base, flexDirection: 'row', gap: theme.spacing.base }}>
            <Button
              variant="primary"
              title="Today’s captures →"
              onPress={goToday}
              style={{ flex: 1 }}
              fullWidth
              testID="go-to-today"
            />
            <Button
              variant="secondary"
              title="Feed"
              onPress={goFeed}
              style={{ flex: 1 }}
              fullWidth
              testID="go-to-feed"
            />
          </View>
          <EmptyState
            title="No groups yet"
            subtitle="Create a private group to share moments, or join one with an invite code."
            action={
              <>
                <Button
                  variant="primary"
                  fullWidth
                  title="New group"
                  onPress={goNew}
                  testID="new-group-button"
                />
                <Button
                  variant="secondary"
                  fullWidth
                  title="Join with a code"
                  onPress={goJoin}
                  testID="join-button"
                />
              </>
            }
          />
        </ScrollView>
      </Screen>
    );
  }

  // ── List ───────────────────────────────────────────────────────────────────
  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: theme.spacing.xl }}>
        <ScreenHeader title="Groups" back={false} right={headerRight} />
      </View>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.base,
          paddingBottom: theme.spacing.section,
          gap: theme.spacing.base,
        }}
        refreshControl={refreshControl}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: 'row', gap: theme.spacing.base }}>
          <Button
            variant="primary"
            title="Today’s captures →"
            onPress={goToday}
            style={{ flex: 1 }}
            fullWidth
            testID="go-to-today"
          />
          <Button
            variant="secondary"
            title="Feed"
            onPress={goFeed}
            style={{ flex: 1 }}
            fullWidth
            testID="go-to-feed"
          />
        </View>

        <View style={{ flexDirection: 'row', gap: theme.spacing.base }}>
          <Button
            variant="primary"
            title="New group"
            onPress={goNew}
            style={{ flex: 1 }}
            fullWidth
            testID="new-group-button"
          />
          <Button
            variant="secondary"
            title="Join"
            onPress={goJoin}
            style={{ flex: 1 }}
            fullWidth
            testID="join-button"
          />
        </View>

        <Text
          variant="micro"
          color="label"
          style={{ marginTop: theme.spacing.lg, marginBottom: theme.spacing.xs }}
        >
          Your groups · {groups.length}
        </Text>

        <View style={{ gap: theme.spacing.base }} testID="groups-list">
          {groups.map((g) => (
            <GroupRow
              key={g.id}
              group={g}
              onPress={() => router.push(`/(app)/groups/${g.id}`)}
              testID={`group-card-${g.id}`}
            />
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}
