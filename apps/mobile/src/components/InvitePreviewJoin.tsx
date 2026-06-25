// InvitePreviewJoin — the shared preview→join unit. Given an invite `code`, it
// fetches a preview (getInvitePreview), renders an Ember preview Card (group avatar,
// name, member count, "already a member" note), and a Join button that calls
// joinInvite, invalidates the groups list, and navigates to the group.
//
// Reused by:
//   • (app)/join.tsx               — manual join-by-code (passes a code typed by the user)
//   • invites/[code].tsx           — deep-link route (passes the URL code), authed branch
//
// Error handling: all branches go through inviteErrors helpers (branch on err.code).
// ALREADY_MEMBER (preview.alreadyMember OR a 409 on join) is treated as success →
// we just navigate to the group.
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { JoinResultDTO } from '@twenty4/contracts';
import { Avatar, Button, Card, Spinner, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { queryClient } from '@/lib/queryClient';
import {
  invitePreviewErrorCopy,
  isAlreadyMember,
  joinErrorCopy,
} from '@/lib/inviteErrors';
import { ErrorRetry } from './QueryState';

export interface InvitePreviewJoinProps {
  /** The invite code to preview + join. */
  code: string;
  /** Optional heading rendered above the preview (e.g. "You're invited"). */
  heading?: string;
}

export function InvitePreviewJoin({ code, heading }: InvitePreviewJoinProps) {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();

  const previewQuery = useQuery({
    queryKey: queryKeys.invites.preview(code),
    queryFn: () => api.getInvitePreview(code),
    retry: 0,
  });

  const goToGroup = (groupId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups.list });
    router.replace(`/(app)/groups/${groupId}`);
  };

  const joinMutation = useMutation<JoinResultDTO, unknown, void>({
    mutationFn: () => api.joinInvite(code),
    onSuccess: (res) => {
      toast.show({ type: 'success', message: 'Joined!' });
      goToGroup(res.groupId);
    },
    onError: (err) => {
      // 409 ALREADY_MEMBER → not an error: just go to the group we already know.
      if (isAlreadyMember(err) && previewQuery.data) {
        toast.show({ type: 'info', message: "You're already in this group" });
        goToGroup(previewQuery.data.groupId);
        return;
      }
      toast.show({ type: 'error', message: joinErrorCopy(err) });
    },
  });

  // Loading the preview.
  if (previewQuery.isLoading) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: theme.spacing.huge,
        }}
      >
        <Spinner size="large" />
      </View>
    );
  }

  // Preview failed → coded, friendly message + a retry.
  if (previewQuery.isError) {
    return (
      <ErrorRetry
        onRetry={() => void previewQuery.refetch()}
        error={previewQuery.error}
        retrying={previewQuery.isFetching}
        title="Invite unavailable"
        message={invitePreviewErrorCopy(previewQuery.error)}
      />
    );
  }

  const preview = previewQuery.data;
  if (!preview) return null;

  return (
    <View style={{ gap: theme.spacing.xl, paddingVertical: theme.spacing.xl }} testID="invite-preview">
      {heading != null ? (
        <Text variant="micro" color="accent" align="center">
          {heading}
        </Text>
      ) : null}

      <Card style={{ alignItems: 'center', gap: theme.spacing.base }}>
        <Avatar size="lg" uri={preview.photoUrl ?? undefined} name={preview.name} />
        <Text variant="h2" align="center" testID="invite-preview-name">
          {preview.name}
        </Text>
        <Text variant="body" color="muted" align="center">
          {preview.memberCount} {preview.memberCount === 1 ? 'member' : 'members'}
        </Text>
        {preview.alreadyMember ? (
          <View
            style={{
              backgroundColor: theme.colors.accentSoft,
              borderRadius: theme.radii.pill,
              paddingHorizontal: theme.spacing.lg,
              paddingVertical: theme.spacing.sm,
            }}
          >
            <Text variant="caption" color="accent">
              You're already a member
            </Text>
          </View>
        ) : null}
      </Card>

      {preview.alreadyMember ? (
        <Button
          variant="primary"
          fullWidth
          title="Open group"
          onPress={() => goToGroup(preview.groupId)}
          testID="invite-open-button"
        />
      ) : (
        <Button
          variant="primary"
          fullWidth
          title="Join group"
          loading={joinMutation.isPending}
          onPress={() => joinMutation.mutate()}
          testID="invite-join-button"
        />
      )}
    </View>
  );
}
