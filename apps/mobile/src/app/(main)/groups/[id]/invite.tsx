/**
 * 4.4 Invite — owner/admin mints an invite (POST /groups/:id/invites), then we
 * show the code, the shareable `twenty4://invite/{code}` deep link, and copy /
 * share / revoke affordances. Expiry + use-cap come back from the API and are
 * surfaced so the inviter knows the link's limits (Q11).
 *
 * Generation is automatic on mount (the screen's whole purpose); a "New link"
 * button re-mints. Web-safe: Share degrades, Clipboard works via expo-clipboard.
 */
import { useEffect, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Platform, Pressable, Share, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { useCreateInvite, useRevokeInvite, groupErrorMessage } from '../../../../lib/groups';
import { customSchemeLink } from '../../../../lib/inviteLink';
import { useTheme } from '../../../../theme';
import { Button, Card, Icon, Skeleton, Toast } from '../../../../ui';
import type { InviteResponse } from '@twenty4/contracts/dto';

export default function Invite() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  const create = useCreateInvite(groupId);
  const revoke = useRevokeInvite(groupId);

  const [invite, setInvite] = useState<InviteResponse | null>(null);
  const [inviteId, setInviteId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'success' | 'info' | 'error'; msg: string } | null>(
    null,
  );

  // Mint a link on first mount. (The API returns the code + deepLink; it does
  // not return the invite row id, so revoke is offered as "make a new link".)
  useEffect(() => {
    if (!groupId) return;
    mint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  function mint() {
    create.mutate(undefined, {
      onSuccess: (res) => {
        setInvite(res);
        setInviteId(null);
        setToast(null);
      },
    });
  }

  const link = invite ? customSchemeLink(invite.code) : '';

  async function copyLink() {
    if (!link) return;
    try {
      await Clipboard.setStringAsync(link);
      setToast({ tone: 'success', msg: 'Invite link copied' });
    } catch {
      setToast({ tone: 'error', msg: 'Couldn’t copy the link' });
    }
  }

  async function copyCode() {
    if (!invite) return;
    try {
      await Clipboard.setStringAsync(invite.code);
      setToast({ tone: 'success', msg: 'Code copied' });
    } catch {
      setToast({ tone: 'error', msg: 'Couldn’t copy the code' });
    }
  }

  async function shareLink() {
    if (!link) return;
    try {
      await Share.share({
        message: `Join my group on twenty4: ${link}`,
        ...(Platform.OS === 'ios' ? { url: link } : {}),
      });
    } catch {
      // user dismissed or share unsupported (web) — fall back to copy.
      await copyLink();
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Invite friends' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.bg }}
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xl,
          gap: theme.spacing.lg,
        }}
      >
        <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: theme.colors.accentSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="person-add" size={30} color={theme.colors.accent} />
          </View>
          <Text style={{ ...theme.typography.heading, color: theme.colors.text }}>
            Invite to the group
          </Text>
          <Text style={{ ...theme.typography.body, color: theme.colors.muted, textAlign: 'center' }}>
            Share this link or code. Anyone with it can join until it expires or hits its limit.
          </Text>
        </View>

        {create.isPending && !invite ? (
          <Card style={{ gap: theme.spacing.md, alignItems: 'center' }}>
            <Skeleton width="55%" height={34} />
            <Skeleton width="80%" height={14} />
          </Card>
        ) : create.isError && !invite ? (
          <Card style={{ gap: theme.spacing.md }}>
            <Toast tone="error" message={groupErrorMessage(create.error)} />
            <Button label="Try again" icon="refresh" fullWidth onPress={mint} />
          </Card>
        ) : invite ? (
          <>
            {/* Code display */}
            <Card style={{ gap: theme.spacing.md, alignItems: 'center' }}>
              <Text style={{ ...theme.typography.label, color: theme.colors.label }}>
                INVITE CODE
              </Text>
              <Pressable accessibilityRole="button" onPress={copyCode} hitSlop={8}>
                <Text
                  selectable
                  style={{
                    fontFamily: theme.fontFamily.monoBold,
                    fontSize: 30,
                    letterSpacing: 4,
                    color: theme.colors.text,
                    textAlign: 'center',
                  }}
                >
                  {invite.code}
                </Text>
              </Pressable>

              {/* Link row */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.sm,
                  alignSelf: 'stretch',
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                  borderRadius: theme.radii.md,
                  backgroundColor: theme.colors.field,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                }}
              >
                <Icon name="link-outline" size={18} color={theme.colors.muted} />
                <Text
                  numberOfLines={1}
                  style={{ flex: 1, ...theme.typography.mono, color: theme.colors.text2 }}
                >
                  {link}
                </Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Copy link" onPress={copyLink} hitSlop={8}>
                  <Icon name="copy-outline" size={20} color={theme.colors.accent} />
                </Pressable>
              </View>

              {/* Limits */}
              <View style={{ flexDirection: 'row', gap: theme.spacing.lg, flexWrap: 'wrap', justifyContent: 'center' }}>
                <Meta icon="time-outline" label={`Expires ${formatExpiry(invite.expiresAt)}`} />
                <Meta
                  icon="people-outline"
                  label={`${invite.maxUses - invite.useCount} of ${invite.maxUses} uses left`}
                />
              </View>
            </Card>

            {toast ? <Toast tone={toast.tone} message={toast.msg} /> : null}

            {/* Actions */}
            <View style={{ gap: theme.spacing.sm }}>
              <Button label="Share invite" icon="share-social" size="lg" fullWidth onPress={shareLink} />
              <Button label="Copy link" icon="copy-outline" variant="secondary" fullWidth onPress={copyLink} />
              <Button
                label="New link"
                icon="refresh"
                variant="ghost"
                fullWidth
                loading={create.isPending}
                onPress={mint}
              />
            </View>
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

function Meta({ icon, label }: { icon: 'time-outline' | 'people-outline'; label: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Icon name={icon} size={15} color={theme.colors.muted} />
      <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>{label}</Text>
    </View>
  );
}

/** Friendly relative expiry ("in 7 days" / "in 6h") from an ISO timestamp. */
function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return 'soon';
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}
