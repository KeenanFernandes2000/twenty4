// (app)/groups/[id] — Group detail. Shows the group identity (avatar, name, member
// count, your role) and action rows: Members, Invite (owner only), and a role-aware
// management area:
//   • non-owner → "Leave group" (confirm → leaveGroup → back to list)
//   • owner     → Rename (patchGroup) + "Archive group" (deleteGroup, confirm)
//                 Owners can't leave (OWNER_CANNOT_LEAVE) so we don't show Leave.
// Errors: 403 NOT_A_MEMBER / 404 GROUP_NOT_FOUND → error state + back to list.
import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '@twenty4/api-client';
import type { GroupDTO } from '@twenty4/contracts';
import { Avatar, Button, Input, Screen, Spinner, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { queryClient } from '@/lib/queryClient';
import { confirm } from '@/lib/confirm';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { ActionRow, RoleBadge, SectionLabel } from '@/components/groups/GroupBits';
import { DetailSkeleton, ErrorRetry } from '@/components/QueryState';

export default function GroupDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const groupQuery = useQuery({
    queryKey: queryKeys.groups.detail(groupId),
    queryFn: () => api.getGroup(groupId),
    enabled: groupId.length > 0,
    retry: 0,
  });

  const backToList = () => router.replace('/(app)');

  const renameMutation = useMutation<GroupDTO, unknown, string>({
    mutationFn: (newName) => api.patchGroup(groupId, { name: newName }),
    onSuccess: (group) => {
      queryClient.setQueryData(queryKeys.groups.detail(groupId), group);
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.list });
      setRenaming(false);
      toast.show({ type: 'success', message: 'Group renamed' });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError && err.code === 'NOT_OWNER'
          ? 'Only the owner can rename the group.'
          : err instanceof ApiError && err.code === 'VALIDATION_FAILED'
            ? 'That name isn’t valid. Use 1–80 characters.'
            : 'Could not rename. Please try again.';
      toast.show({ type: 'error', message });
    },
  });

  const leaveMutation = useMutation<{ status: string }, unknown, void>({
    mutationFn: () => api.leaveGroup(groupId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.list });
      // Drop the now-stale detail + members caches so no phantom membership remains
      // (mirrors archiveMutation).
      queryClient.removeQueries({ queryKey: queryKeys.groups.detail(groupId) });
      queryClient.removeQueries({ queryKey: queryKeys.groups.members(groupId) });
      toast.show({ type: 'success', message: 'You left the group' });
      backToList();
    },
    onError: (err) => {
      const message =
        err instanceof ApiError && err.code === 'OWNER_CANNOT_LEAVE'
          ? 'Owners can’t leave — archive the group instead.'
          : 'Could not leave. Please try again.';
      toast.show({ type: 'error', message });
    },
  });

  const archiveMutation = useMutation<{ status: string }, unknown, void>({
    mutationFn: () => api.deleteGroup(groupId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.list });
      queryClient.removeQueries({ queryKey: queryKeys.groups.detail(groupId) });
      toast.show({ type: 'success', message: 'Group archived' });
      backToList();
    },
    onError: (err) => {
      const message =
        err instanceof ApiError && err.code === 'NOT_OWNER'
          ? 'Only the owner can archive the group.'
          : 'Could not archive. Please try again.';
      toast.show({ type: 'error', message });
    },
  });

  // ── Loading ────────────────────────────────────────────────────────────────
  if (groupQuery.isLoading) {
    return (
      <Screen scroll>
        <ScreenHeader title="Group" />
        <DetailSkeleton />
      </Screen>
    );
  }

  // ── Error (membership / not found vs transient) ──────────────────────────────
  if (groupQuery.isError) {
    const err = groupQuery.error;
    const known =
      err instanceof ApiError &&
      (err.code === 'NOT_A_MEMBER' || err.code === 'GROUP_NOT_FOUND' || err.code === 'NOT_FOUND');
    if (known) {
      const isNotMember = err instanceof ApiError && err.code === 'NOT_A_MEMBER';
      return (
        <Screen>
          <ScreenHeader title="Group" onBack={backToList} />
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.spacing.xl,
              paddingVertical: theme.spacing.huge,
            }}
          >
            <Text variant="title" align="center">
              {isNotMember ? 'You’re not a member' : 'Group not found'}
            </Text>
            <Text variant="body" color="muted" align="center">
              {isNotMember
                ? 'You don’t have access to this group anymore.'
                : 'This group no longer exists.'}
            </Text>
            <Button variant="secondary" title="Back to groups" onPress={backToList} />
          </View>
        </Screen>
      );
    }
    return (
      <Screen>
        <ScreenHeader title="Group" onBack={backToList} />
        <ErrorRetry
          onRetry={() => void groupQuery.refetch()}
          error={err}
          retrying={groupQuery.isFetching}
        />
      </Screen>
    );
  }

  const group = groupQuery.data;
  if (!group) return null;
  const isOwner = group.role === 'owner';

  const onLeave = async () => {
    const ok = await confirm({
      title: 'Leave group?',
      message: `You’ll lose access to “${group.name}”. You can re-join with an invite.`,
      confirmLabel: 'Leave',
    });
    if (ok) leaveMutation.mutate();
  };

  const onArchive = async () => {
    const ok = await confirm({
      title: 'Archive group?',
      message: `“${group.name}” will be archived for everyone. This can’t be undone here.`,
      confirmLabel: 'Archive',
    });
    if (ok) archiveMutation.mutate();
  };

  const startRename = () => {
    setNameDraft(group.name);
    setRenaming(true);
  };

  const submitRename = () => {
    const next = nameDraft.trim();
    if (next.length < 1 || next.length > 80 || renameMutation.isPending) return;
    if (next === group.name) {
      setRenaming(false);
      return;
    }
    renameMutation.mutate(next);
  };

  return (
    <Screen scroll>
      <ScreenHeader title="Group" />

      {/* Identity */}
      <View style={{ alignItems: 'center', gap: theme.spacing.base, paddingVertical: theme.spacing.lg }}>
        <Avatar size="lg" uri={group.photoUrl ?? undefined} name={group.name} />
        {renaming ? (
          <View style={{ width: '100%', gap: theme.spacing.base }}>
            <View testID="rename-input">
              <Input
                label="Group name"
                value={nameDraft}
                onChangeText={setNameDraft}
                autoCapitalize="words"
                maxLength={80}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={submitRename}
              />
            </View>
            <View style={{ flexDirection: 'row', gap: theme.spacing.base }}>
              <Button
                variant="ghost"
                title="Cancel"
                onPress={() => setRenaming(false)}
                style={{ flex: 1 }}
                fullWidth
              />
              <Button
                variant="primary"
                title="Save"
                loading={renameMutation.isPending}
                onPress={submitRename}
                style={{ flex: 1 }}
                fullWidth
                testID="rename-save-button"
              />
            </View>
          </View>
        ) : (
          <>
            <Text variant="h1" align="center" testID="group-detail-name">
              {group.name}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              <Text variant="body" color="muted">
                {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
              </Text>
              <RoleBadge role={group.role} />
            </View>
          </>
        )}
      </View>

      {!renaming ? (
        <View style={{ gap: theme.spacing.base }}>
          <SectionLabel>Group</SectionLabel>
          <ActionRow
            label="Members"
            sublabel={`${group.memberCount} ${group.memberCount === 1 ? 'person' : 'people'}`}
            onPress={() => router.push(`/(app)/groups/${group.id}/members`)}
            testID="members-action"
          />
          {isOwner ? (
            <ActionRow
              label="Invite people"
              sublabel="Create a shareable invite code"
              onPress={() => router.push(`/(app)/groups/${group.id}/invite`)}
              testID="invite-action"
            />
          ) : null}

          {isOwner ? (
            <>
              <SectionLabel>Owner settings</SectionLabel>
              <ActionRow
                label="Rename group"
                onPress={startRename}
                trailing={
                  <Text variant="caption" color="accent">
                    Edit
                  </Text>
                }
                testID="rename-action"
              />
              <ActionRow
                label="Archive group"
                sublabel="Closes the group for everyone"
                danger
                onPress={onArchive}
                trailing={
                  archiveMutation.isPending ? <Spinner size="small" color={theme.colors.danger} /> : undefined
                }
                testID="archive-action"
              />
            </>
          ) : (
            <>
              <SectionLabel>Membership</SectionLabel>
              <ActionRow
                label="Leave group"
                danger
                onPress={onLeave}
                trailing={
                  leaveMutation.isPending ? <Spinner size="small" color={theme.colors.danger} /> : undefined
                }
                testID="leave-action"
              />
            </>
          )}
        </View>
      ) : null}
    </Screen>
  );
}
