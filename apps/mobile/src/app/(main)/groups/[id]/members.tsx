/**
 * 4.6 Members — list of active members with roles. Owner/admin get manage
 * actions per row (remove), gated by the strict role hierarchy the backend
 * enforces (actor must outrank target; never self → that's "Leave"). Removal is
 * optimistic (useRemoveMember) with rollback + an error toast on failure.
 *
 * Data: useGroup (for my role) + useGroupMembers + useMe (to find "you").
 */
import { useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView } from 'react-native';

import {
  useGroup,
  useGroupMembers,
  useMe,
  useRemoveMember,
  groupErrorMessage,
} from '../../../../lib/groups';
import { useTheme } from '../../../../theme';
import {
  Avatar,
  Button,
  Card,
  ErrorRetry,
  Icon,
  Sheet,
  Skeleton,
  Toast,
} from '../../../../ui';
import { RoleBadge } from '../index';
import type { GroupMemberResponse } from '@twenty4/contracts/dto';

type Role = 'owner' | 'admin' | 'member';
const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

export default function GroupMembers() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const groupId = id ?? '';

  const group = useGroup(groupId);
  const members = useGroupMembers(groupId);
  const me = useMe();
  const remove = useRemoveMember(groupId);

  const [target, setTarget] = useState<GroupMemberResponse | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const myRole = (group.data?.myRole ?? 'member') as Role;
  const myId = me.data?.id;
  const items = members.data?.items ?? [];

  /** Can the current user remove this member? (strict outrank + not self). */
  function canRemove(m: GroupMemberResponse): boolean {
    if (!myId || m.user.id === myId) return false;
    if (myRole !== 'owner' && myRole !== 'admin') return false;
    return RANK[myRole] > RANK[m.role as Role];
  }

  function confirmRemove() {
    if (!target) return;
    const userId = target.user.id;
    const name = target.user.displayName || target.user.username;
    setTarget(null);
    remove.mutate(userId, {
      onSuccess: () => setToast(`Removed ${name}.`),
      onError: (e) => setToast(groupErrorMessage(e)),
    });
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Members' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.bg }}
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xl,
          gap: theme.spacing.md,
        }}
      >
        {toast ? <Toast tone="info" message={toast} /> : null}

        {members.isLoading ? (
          <MembersSkeleton />
        ) : members.isError ? (
          <ErrorRetry
            message={groupErrorMessage(members.error)}
            onRetry={() => void members.refetch()}
          />
        ) : (
          <Card padded={false}>
            {items.map((m, idx) => {
              const isYou = m.user.id === myId;
              const name = m.user.displayName || m.user.username || 'Member';
              return (
                <View key={m.user.id}>
                  {idx > 0 ? (
                    <View style={{ height: 1, backgroundColor: theme.colors.border, marginLeft: 64 }} />
                  ) : null}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: theme.spacing.md,
                      padding: theme.spacing.lg,
                    }}
                  >
                    <Avatar
                      name={name}
                      uri={m.user.profilePhotoUrl ?? undefined}
                      size={44}
                    />
                    <View style={{ flex: 1, gap: 2 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text
                          numberOfLines={1}
                          style={{ ...theme.typography.bodyStrong, color: theme.colors.text }}
                        >
                          {name}
                        </Text>
                        {isYou ? (
                          <Text style={{ ...theme.typography.label, color: theme.colors.muted }}>
                            (You)
                          </Text>
                        ) : null}
                      </View>
                      {m.user.username ? (
                        <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>
                          @{m.user.username}
                        </Text>
                      ) : null}
                    </View>
                    <RoleBadge role={m.role as Role} />
                    {canRemove(m) ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${name}`}
                        onPress={() => setTarget(m)}
                        hitSlop={8}
                        style={({ pressed }) => ({
                          padding: 6,
                          opacity: pressed ? 0.6 : 1,
                        })}
                      >
                        <Icon name="remove-circle-outline" size={22} color={theme.colors.danger} />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </Card>
        )}
      </ScrollView>

      <Sheet
        visible={!!target}
        onClose={() => setTarget(null)}
        title={target ? `Remove ${target.user.displayName || target.user.username}?` : 'Remove member'}
      >
        <View style={{ gap: theme.spacing.md }}>
          <Text style={{ ...theme.typography.body, color: theme.colors.muted }}>
            They’ll lose access to this group’s recaps and need a new invite to rejoin.
          </Text>
          <Button
            label="Remove"
            variant="danger"
            icon="remove-circle-outline"
            fullWidth
            loading={remove.isPending}
            onPress={confirmRemove}
          />
          <Button label="Cancel" variant="ghost" fullWidth onPress={() => setTarget(null)} />
        </View>
      </Sheet>
    </>
  );
}

function MembersSkeleton() {
  const theme = useTheme();
  return (
    <Card padded={false}>
      {[0, 1, 2, 3, 4].map((i) => (
        <View
          key={i}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            padding: theme.spacing.lg,
          }}
        >
          <Skeleton width={44} height={44} radius={22} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width="50%" height={15} />
            <Skeleton width="30%" height={12} />
          </View>
        </View>
      ))}
    </Card>
  );
}
