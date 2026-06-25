// (app)/groups/[id]/invite — owner-only invite/share. "Generate invite" creates an
// invite (createInvite). We then show the code large (JetBrains Mono), its expiry and
// uses, and Copy / Share / Revoke actions. Share uses RN's Share.share with the
// twenty4://invites/<code> deep link; Copy uses expo-clipboard (web-safe). A non-owner
// who reaches this screen sees an explanatory message instead of the generator.
import { useState } from 'react';
import { Share, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { ApiError } from '@twenty4/api-client';
import type { InviteDTO } from '@twenty4/contracts';
import { Button, Card, Screen, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ScreenHeader } from '@/components/groups/ScreenHeader';

// twenty4://invites/<code> — matches the deep-link route src/app/invites/[code].tsx.
// Use the configured scheme; expo-linking would also work but a literal keeps it
// obvious and avoids an extra import.
function inviteDeepLink(code: string): string {
  return `twenty4://invites/${code}`;
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export default function InviteScreen() {
  const theme = useTheme();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';
  const [invite, setInvite] = useState<InviteDTO | null>(null);

  // Read role from the (likely cached) group detail to gate the UI to owners.
  const groupQuery = useQuery({
    queryKey: queryKeys.groups.detail(groupId),
    queryFn: () => api.getGroup(groupId),
    enabled: groupId.length > 0,
    retry: 0,
  });
  const isOwner = groupQuery.data?.role === 'owner';
  const groupName = groupQuery.data?.name ?? 'this group';

  const createMutation = useMutation<InviteDTO, unknown, void>({
    mutationFn: () => api.createInvite(groupId),
    onSuccess: (created) => {
      setInvite(created);
      toast.show({ type: 'success', message: 'Invite created' });
    },
    onError: (err) => {
      const message =
        err instanceof ApiError && err.code === 'NOT_OWNER'
          ? 'Only the owner can create invites.'
          : err instanceof ApiError && err.code === 'RATE_LIMITED'
            ? 'Too many invites. Please wait a bit and try again.'
            : 'Could not create an invite. Please try again.';
      toast.show({ type: 'error', message });
    },
  });

  const revokeMutation = useMutation<{ status: string }, unknown, string>({
    mutationFn: (inviteId) => api.revokeInvite(groupId, inviteId),
    onSuccess: () => {
      setInvite(null);
      toast.show({ type: 'info', message: 'Invite revoked' });
    },
    onError: () => {
      toast.show({ type: 'error', message: 'Could not revoke. Please try again.' });
    },
  });

  const onCopy = async () => {
    if (!invite) return;
    try {
      await Clipboard.setStringAsync(invite.code);
      toast.show({ type: 'success', message: 'Code copied' });
    } catch {
      toast.show({ type: 'error', message: 'Could not copy' });
    }
  };

  const onShare = async () => {
    if (!invite) return;
    const link = inviteDeepLink(invite.code);
    const message = `Join “${groupName}” on twenty4. Tap to open: ${link}\nOr enter the code: ${invite.code}`;
    try {
      await Share.share({ message });
    } catch {
      // user cancelled or share unavailable — no toast needed for a cancel.
    }
  };

  // ── Non-owner guard ──────────────────────────────────────────────────────────
  if (groupQuery.data && !isOwner) {
    return (
      <Screen>
        <ScreenHeader title="Invite" />
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
            Owner only
          </Text>
          <Text variant="body" color="muted" align="center">
            Only the group owner can create invites.
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <ScreenHeader title="Invite people" />
      <View style={{ gap: theme.spacing.xl, paddingTop: theme.spacing.lg }}>
        {invite == null ? (
          <>
            <Text variant="body" color="muted">
              Create a shareable code so people can join {groupName}. Invites last 7 days
              and can be used up to 25 times.
            </Text>
            <Button
              variant="primary"
              fullWidth
              title="Generate invite"
              loading={createMutation.isPending}
              onPress={() => createMutation.mutate()}
              testID="generate-invite-button"
            />
          </>
        ) : (
          <>
            <Card style={{ alignItems: 'center', gap: theme.spacing.base }}>
              <Text variant="micro" color="label">
                Invite code
              </Text>
              <Text
                variant="h1"
                weight="monoBold"
                align="center"
                selectable
                testID="invite-code"
                style={{ letterSpacing: 2 }}
              >
                {invite.code}
              </Text>
              <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
                <Text variant="caption" color="muted">
                  Expires in {daysUntil(invite.expiresAt)}{' '}
                  {daysUntil(invite.expiresAt) === 1 ? 'day' : 'days'}
                </Text>
                <Text variant="caption" color="muted">
                  {invite.useCount}/{invite.maxUses} used
                </Text>
              </View>
            </Card>

            <View style={{ flexDirection: 'row', gap: theme.spacing.base }}>
              <Button
                variant="secondary"
                title="Copy"
                onPress={() => {
                  void onCopy();
                }}
                style={{ flex: 1 }}
                fullWidth
                testID="copy-invite-button"
              />
              <Button
                variant="primary"
                title="Share"
                onPress={() => {
                  void onShare();
                }}
                style={{ flex: 1 }}
                fullWidth
                testID="share-invite-button"
              />
            </View>

            <Button
              variant="ghost"
              fullWidth
              title="Revoke this invite"
              loading={revokeMutation.isPending}
              onPress={() => revokeMutation.mutate(invite.id)}
              testID="revoke-invite-button"
            />
          </>
        )}
      </View>
    </Screen>
  );
}
