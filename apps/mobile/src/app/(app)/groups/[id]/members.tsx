// (app)/groups/[id]/members — the roster. Lists members (avatar, name, @username,
// role badge). If the current user is the group OWNER, each non-self / non-owner row
// gets a Remove affordance (confirm → removeMember → invalidate members + detail).
// Non-owners just see the roster. We read the caller's role from the cached group
// detail (falling back to a fetch) and the current user id from the auth store.
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '@twenty4/api-client';
import type { GroupDTO, MemberDTO } from '@twenty4/contracts';
import { Button, Screen, Spinner, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { queryClient } from '@/lib/queryClient';
import { confirm } from '@/lib/confirm';
import { useAuthUser } from '@/stores/authStore';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { MemberRow } from '@/components/groups/GroupBits';
import { ErrorRetry, ListSkeleton } from '@/components/QueryState';

export default function MembersScreen() {
  const theme = useTheme();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const me = useAuthUser();

  const membersQuery = useQuery({
    queryKey: queryKeys.groups.members(groupId),
    queryFn: () => api.listMembers(groupId),
    enabled: groupId.length > 0,
    retry: 0,
  });

  // The caller's role: prefer the cached group detail; if absent, fetch it (cheap,
  // and shared with the detail screen's cache).
  const groupQuery = useQuery({
    queryKey: queryKeys.groups.detail(groupId),
    queryFn: () => api.getGroup(groupId),
    enabled: groupId.length > 0,
    retry: 0,
  });
  const group: GroupDTO | undefined = groupQuery.data;
  const isOwner = group?.role === 'owner';

  const removeMutation = useMutation<{ status: string }, unknown, string>({
    mutationFn: (userId) => api.removeMember(groupId, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.members(groupId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.detail(groupId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.list });
      toast.show({ type: 'success', message: 'Member removed' });
    },
    onError: (err) => {
      let message = 'Could not remove this member. Please try again.';
      if (err instanceof ApiError) {
        switch (err.code) {
          case 'CANNOT_REMOVE_SELF':
            message = 'You can’t remove yourself. Use “Leave group” instead.';
            break;
          case 'CANNOT_REMOVE_OWNER':
            message = 'The owner can’t be removed.';
            break;
          case 'NOT_OWNER':
            message = 'Only the owner can remove members.';
            break;
          case 'NOT_A_MEMBER':
            message = 'That person is no longer a member.';
            break;
        }
      }
      toast.show({ type: 'error', message });
    },
  });

  const onRemove = async (member: MemberDTO) => {
    const name = member.displayName ?? member.username ?? 'this member';
    const ok = await confirm({
      title: `Remove ${name}?`,
      message: 'They’ll lose access to the group but can be re-invited.',
      confirmLabel: 'Remove',
    });
    if (ok) removeMutation.mutate(member.userId);
  };

  // ── Loading ────────────────────────────────────────────────────────────────
  if (membersQuery.isLoading) {
    return (
      <Screen>
        <ScreenHeader title="Members" />
        <View style={{ paddingTop: theme.spacing.base }}>
          <ListSkeleton count={5} />
        </View>
      </Screen>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (membersQuery.isError) {
    const err = membersQuery.error;
    const notMember = err instanceof ApiError && err.code === 'NOT_A_MEMBER';
    if (notMember) {
      return (
        <Screen>
          <ScreenHeader title="Members" />
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.spacing.base,
              paddingVertical: theme.spacing.huge,
            }}
          >
            <Text variant="title" align="center">
              You’re not a member
            </Text>
            <Text variant="body" color="muted" align="center">
              You don’t have access to this group’s members.
            </Text>
          </View>
        </Screen>
      );
    }
    return (
      <Screen>
        <ScreenHeader title="Members" />
        <ErrorRetry
          onRetry={() => void membersQuery.refetch()}
          error={err}
          retrying={membersQuery.isFetching}
        />
      </Screen>
    );
  }

  const members = membersQuery.data ?? [];

  return (
    <Screen scroll>
      <ScreenHeader title={`Members · ${members.length}`} />
      <View style={{ gap: theme.spacing.base, paddingTop: theme.spacing.base }} testID="members-list">
        {members.map((member) => {
          const isSelf = me?.id === member.userId;
          const canRemove = isOwner && !isSelf && member.role !== 'owner';
          return (
            <MemberRow
              key={member.userId}
              member={member}
              isSelf={isSelf}
              testID={`member-row-${member.userId}`}
              trailing={
                canRemove ? (
                  <Button
                    variant="danger"
                    size="sm"
                    title="Remove"
                    loading={
                      removeMutation.isPending && removeMutation.variables === member.userId
                    }
                    onPress={() => {
                      void onRemove(member);
                    }}
                    testID={`remove-member-${member.userId}`}
                  />
                ) : undefined
              }
            />
          );
        })}
      </View>
    </Screen>
  );
}
