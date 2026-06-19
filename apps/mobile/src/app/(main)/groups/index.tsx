/**
 * 4.1 Groups — the caller's groups list.
 *
 * Data: `useGroups()` (GET /groups). States: loading skeletons, error+retry,
 * empty (no groups yet → create or join), and the populated list. A FAB opens
 * the create screen; a header action opens join (enter a code). Each row pushes
 * the group detail (4.2). Strictly themed — no raw colors.
 */
import { Stack, useRouter } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useGroups, groupErrorMessage } from '../../../lib/groups';
import { useTheme } from '../../../theme';
import {
  Avatar,
  Card,
  EmptyState,
  ErrorRetry,
  Icon,
  Skeleton,
} from '../../../ui';
import type { GroupResponse } from '@twenty4/contracts/dto';

export default function GroupsIndex() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, isLoading, isError, error, refetch, isRefetching } = useGroups();

  const items = data?.items ?? [];

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Groups',
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Join a group with a code"
              onPress={() => router.push('/(main)/groups/join')}
              hitSlop={10}
              style={{ paddingHorizontal: theme.spacing.md }}
            >
              <Icon name="enter-outline" size={22} color={theme.colors.accent} />
            </Pressable>
          ),
        }}
      />
      <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        <ScrollView
          contentContainerStyle={{
            padding: theme.spacing.lg,
            paddingBottom: insets.bottom + 96,
            gap: theme.spacing.md,
            flexGrow: 1,
          }}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => void refetch()}
              tintColor={theme.colors.accent}
            />
          }
        >
          {isLoading ? (
            <GroupListSkeleton />
          ) : isError ? (
            <ErrorRetry message={groupErrorMessage(error)} onRetry={() => void refetch()} />
          ) : items.length === 0 ? (
            <View style={{ flexGrow: 1, justifyContent: 'center' }}>
              <EmptyState
                icon="people-outline"
                title="No groups yet"
                body="Create a group for your friends, or join one with an invite code."
                actionLabel="Create a group"
                onAction={() => router.push('/(main)/groups/create')}
              />
              <View style={{ alignItems: 'center', marginTop: theme.spacing.sm }}>
                <Text
                  accessibilityRole="link"
                  onPress={() => router.push('/(main)/groups/join')}
                  style={{
                    ...theme.typography.bodyStrong,
                    color: theme.colors.accent,
                  }}
                >
                  I have an invite code
                </Text>
              </View>
            </View>
          ) : (
            items.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                onPress={() => router.push(`/(main)/groups/${g.id}`)}
              />
            ))
          )}
        </ScrollView>

        {/* FAB → create (hidden on the error/loading panes to avoid double CTAs) */}
        {!isError ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create a group"
            onPress={() => router.push('/(main)/groups/create')}
            style={({ pressed }) => ({
              position: 'absolute',
              right: theme.spacing.lg,
              bottom: insets.bottom + theme.spacing.lg,
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: theme.colors.accent,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.85 : 1,
              shadowColor: theme.colors.scrim,
              shadowOpacity: 0.4,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 3 },
              elevation: theme.elevation.lg,
            })}
          >
            <Icon name="add" size={28} color={theme.colors.onAccent} />
          </Pressable>
        ) : null}
      </View>
    </>
  );
}

/** A single group row → name, member count, your-role badge, photo/initials. */
function GroupRow({ group, onPress }: { group: GroupResponse; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Card padded={false} style={{ overflow: 'hidden' }}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          padding: theme.spacing.lg,
          backgroundColor: pressed ? theme.colors.surface2 : 'transparent',
        })}
      >
        <Avatar name={group.name} uri={group.photoUrl ?? undefined} size={48} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            numberOfLines={1}
            style={{ ...theme.typography.subheading, color: theme.colors.text }}
          >
            {group.name}
          </Text>
          <Text style={{ ...theme.typography.caption, color: theme.colors.muted }}>
            {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
          </Text>
        </View>
        {group.myRole !== 'member' ? <RoleBadge role={group.myRole} /> : null}
        <Icon name="chevron-forward" size={18} color={theme.colors.faint} />
      </Pressable>
    </Card>
  );
}

/** Small pill marking owner/admin standing. */
export function RoleBadge({ role }: { role: 'owner' | 'admin' | 'member' }) {
  const theme = useTheme();
  if (role === 'member') return null;
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: theme.radii.pill,
        backgroundColor: theme.colors.accentSoft,
      }}
    >
      <Text style={{ ...theme.typography.label, color: theme.colors.accent }}>
        {role.toUpperCase()}
      </Text>
    </View>
  );
}

function GroupListSkeleton() {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.md }}>
      {[0, 1, 2, 3].map((i) => (
        <Card key={i}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
            <Skeleton width={48} height={48} radius={24} />
            <View style={{ flex: 1, gap: 8 }}>
              <Skeleton width="60%" height={16} />
              <Skeleton width="35%" height={12} />
            </View>
          </View>
        </Card>
      ))}
    </View>
  );
}
