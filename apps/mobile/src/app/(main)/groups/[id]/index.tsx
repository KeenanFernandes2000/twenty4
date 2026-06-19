/**
 * 4.2 Group detail — header (name/photo/role), members preview (→ 4.6), group
 * montages placeholder (Slice 5/6 wires the feed), and an action set gated by
 * role: invite (owner/admin → 4.4), edit/rename + archive (owner/admin / owner),
 * and leave (everyone). Settings live in an inline Sheet to keep web-safe.
 *
 * Data: useGroup + useGroupMembers + useMe (for self / role-aware actions).
 */
import { useMemo, useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView } from 'react-native';

import {
  useGroup,
  useGroupMembers,
  useMe,
  useUpdateGroup,
  useArchiveGroup,
  useLeaveGroup,
  groupErrorMessage,
  errorReason,
} from '../../../../lib/groups';
import { useTheme } from '../../../../theme';
import {
  Avatar,
  Button,
  Card,
  ErrorRetry,
  Field,
  Icon,
  ListRow,
  Sheet,
  Skeleton,
  Toast,
} from '../../../../ui';
import { RoleBadge } from '../index';

export default function GroupDetail() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  const group = useGroup(groupId);
  const members = useGroupMembers(groupId);
  const me = useMe();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const update = useUpdateGroup(groupId);
  const archive = useArchiveGroup();
  const leave = useLeaveGroup();

  const role = group.data?.myRole ?? 'member';
  const canManage = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';

  const memberItems = members.data?.items ?? [];
  const preview = useMemo(() => memberItems.slice(0, 5), [memberItems]);

  function openSettings() {
    setEditName(group.data?.name ?? '');
    setActionError(null);
    setSettingsOpen(true);
  }

  function saveName() {
    const next = editName.trim();
    if (!next || next === group.data?.name) {
      setSettingsOpen(false);
      return;
    }
    setActionError(null);
    update.mutate(
      { name: next },
      {
        onSuccess: () => setSettingsOpen(false),
        onError: (e) => setActionError(groupErrorMessage(e)),
      },
    );
  }

  function doArchive() {
    setActionError(null);
    archive.mutate(groupId, {
      onSuccess: () => {
        setSettingsOpen(false);
        router.back();
      },
      onError: (e) => setActionError(groupErrorMessage(e)),
    });
  }

  function doLeave() {
    setActionError(null);
    leave.mutate(groupId, {
      onSuccess: () => {
        setLeaveOpen(false);
        router.back();
      },
      onError: (e) => {
        // Sole-owner-of-non-empty → 409 with reason `sole_owner`.
        const reason = errorReason(e);
        setActionError(
          reason === 'sole_owner'
            ? 'You’re the only owner. Promote another member or archive the group before leaving.'
            : groupErrorMessage(e),
        );
      },
    });
  }

  if (group.isError) {
    return (
      <>
        <Stack.Screen options={{ title: 'Group' }} />
        <View style={{ flex: 1, backgroundColor: theme.colors.bg, justifyContent: 'center' }}>
          <ErrorRetry
            title={group.error && groupErrorMessage(group.error).includes('member') ? 'Not available' : 'Couldn’t load group'}
            message={groupErrorMessage(group.error)}
            onRetry={() => void group.refetch()}
          />
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: group.data?.name ?? 'Group',
          headerRight: () =>
            canManage && group.data ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Group settings"
                onPress={openSettings}
                hitSlop={10}
                style={{ paddingHorizontal: theme.spacing.md }}
              >
                <Icon name="settings-outline" size={22} color={theme.colors.accent} />
              </Pressable>
            ) : null,
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.bg }}
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xl,
          gap: theme.spacing.lg,
        }}
      >
        {/* Header */}
        <Card style={{ alignItems: 'center', gap: theme.spacing.sm }}>
          {group.isLoading ? (
            <>
              <Skeleton width={88} height={88} radius={44} />
              <Skeleton width="50%" height={20} />
              <Skeleton width="30%" height={12} />
            </>
          ) : (
            <>
              <Avatar
                name={group.data?.name}
                uri={group.data?.photoUrl ?? undefined}
                size={88}
              />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                <Text style={{ ...theme.typography.title, color: theme.colors.text }}>
                  {group.data?.name}
                </Text>
                <RoleBadge role={role} />
              </View>
              <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>
                {group.data?.memberCount ?? 0}{' '}
                {group.data?.memberCount === 1 ? 'member' : 'members'}
              </Text>
            </>
          )}
        </Card>

        {/* Primary actions */}
        <View style={{ gap: theme.spacing.sm }}>
          {canManage ? (
            <Button
              label="Invite friends"
              icon="person-add"
              fullWidth
              size="lg"
              onPress={() => router.push(`/(main)/groups/${groupId}/invite`)}
            />
          ) : null}
        </View>

        {/* Members preview → 4.6 */}
        <Card padded={false}>
          <ListRow
            title="Members"
            subtitle={`${group.data?.memberCount ?? memberItems.length} in this group`}
            leadingIcon="people-outline"
            showChevron
            onPress={() => router.push(`/(main)/groups/${groupId}/members`)}
          />
          {members.isLoading ? (
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm, padding: theme.spacing.lg, paddingTop: 0 }}>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} width={40} height={40} radius={20} />
              ))}
            </View>
          ) : preview.length > 0 ? (
            <View
              style={{
                flexDirection: 'row',
                paddingHorizontal: theme.spacing.lg,
                paddingBottom: theme.spacing.lg,
              }}
            >
              {preview.map((m, idx) => (
                <View key={m.user.id} style={{ marginLeft: idx === 0 ? 0 : -10 }}>
                  <View
                    style={{
                      borderRadius: 22,
                      borderWidth: 2,
                      borderColor: theme.colors.surface,
                    }}
                  >
                    <Avatar
                      name={m.user.displayName || m.user.username}
                      uri={m.user.profilePhotoUrl ?? undefined}
                      size={40}
                    />
                  </View>
                </View>
              ))}
              {memberItems.length > preview.length ? (
                <View
                  style={{
                    marginLeft: -10,
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    borderWidth: 2,
                    borderColor: theme.colors.surface,
                    backgroundColor: theme.colors.surface2,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ ...theme.typography.label, color: theme.colors.muted }}>
                    +{memberItems.length - preview.length}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </Card>

        {/* Group montages placeholder (Slice 5/6 wires real recaps) */}
        <Card>
          <View style={{ gap: theme.spacing.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
              <Icon name="film-outline" size={20} color={theme.colors.accent} />
              <Text style={{ ...theme.typography.subheading, color: theme.colors.text }}>
                Recaps
              </Text>
            </View>
            <View
              style={{
                aspectRatio: 16 / 7,
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.surface2,
                borderWidth: 1,
                borderColor: theme.colors.border,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
            >
              <Icon name="sparkles-outline" size={26} color={theme.colors.faint} />
              <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>
                Today’s recaps will appear here
              </Text>
            </View>
          </View>
        </Card>

        {/* Leave */}
        <Card padded={false}>
          <ListRow
            title="Leave group"
            leadingIcon="exit-outline"
            danger
            onPress={() => {
              setActionError(null);
              setLeaveOpen(true);
            }}
          />
        </Card>
      </ScrollView>

      {/* Settings sheet (owner/admin) */}
      <Sheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} title="Group settings">
        <View style={{ gap: theme.spacing.lg }}>
          <Field
            label="Group name"
            value={editName}
            onChangeText={setEditName}
            maxLength={60}
            placeholder="Group name"
          />
          {actionError ? <Toast tone="error" message={actionError} /> : null}
          <Button
            label="Save changes"
            fullWidth
            loading={update.isPending}
            onPress={saveName}
          />
          {isOwner ? (
            <Button
              label="Archive group"
              variant="danger"
              icon="archive-outline"
              fullWidth
              loading={archive.isPending}
              onPress={doArchive}
            />
          ) : null}
          <Button label="Done" variant="ghost" fullWidth onPress={() => setSettingsOpen(false)} />
        </View>
      </Sheet>

      {/* Leave confirm sheet */}
      <Sheet visible={leaveOpen} onClose={() => setLeaveOpen(false)} title="Leave this group?">
        <View style={{ gap: theme.spacing.md }}>
          <Text style={{ ...theme.typography.body, color: theme.colors.muted }}>
            You’ll stop seeing this group’s recaps and need a new invite to rejoin.
          </Text>
          {actionError ? <Toast tone="error" message={actionError} /> : null}
          <Button
            label="Leave group"
            variant="danger"
            icon="exit-outline"
            fullWidth
            loading={leave.isPending}
            onPress={doLeave}
          />
          <Button label="Stay" variant="ghost" fullWidth onPress={() => setLeaveOpen(false)} />
        </View>
      </Sheet>
    </>
  );
}
