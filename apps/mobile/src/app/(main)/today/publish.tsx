/**
 * 2.8 Publish group selection — "Share to". Multi-select which groups the recap
 * goes to, then publish. One render → many visibility rows (Q1). Publish is
 * idempotent (a stable Idempotency-Key per attempt dedupes retries), and on
 * success the montage flips to `published` (optimistically) and routes to 2.9.
 *
 * Design (Spool 2.8): group rows with avatar + member count; selected rows get
 * an accent border + a check; a footer notes the 24h life and the publish count.
 * Web-safe via mock groups + mock montage.
 */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { useTheme } from '../../../theme';
import { Avatar, Button, EmptyState, ErrorRetry, Icon, Skeleton } from '../../../ui';
import { useGroups, groupErrorMessage } from '../../../lib/groups';
import { usePublish, useReplace, montageErrorStatus, montageErrorMessage } from '../../../lib/montage';
import { ReplaceConfirmSheet } from '../../../features/montage/ReplaceConfirmSheet';
import { trackMontagePublished } from '../../../lib/analytics';
import { montageMockActive, MOCK_PUBLISH_GROUPS } from '../../../lib/montageMocks';

interface GroupChoice {
  id: string;
  name: string;
  memberCount: number;
  photoUrl?: string | null;
}

export default function Publish() {
  const theme = useTheme();
  const c = theme.colors;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, replace } = useLocalSearchParams<{ id?: string; replace?: string }>();

  const mock = montageMockActive();
  const groupsQuery = useGroups({ enabled: !mock });
  const groups: GroupChoice[] = mock
    ? MOCK_PUBLISH_GROUPS
    : (groupsQuery.data?.items ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        memberCount: g.memberCount,
        photoUrl: g.photoUrl,
      }));

  const publish = usePublish(id ?? '');
  const replaceMutation = useReplace(id ?? '');

  // In mock screenshots we preselect the first two groups so the populated +
  // selected state is visible without interaction.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(mock ? MOCK_PUBLISH_GROUPS.slice(0, 2).map((g) => g.id) : []),
  );
  // Replace-confirm sheet (Q2): opened on a 409 conflict (today's recap already
  // published to a selected group), or via ?replace=1 for the screenshot.
  const [replaceOpen, setReplaceOpen] = useState(mock && replace === '1');
  // A stable idempotency key for this publish attempt (regenerated each mount).
  const idempotencyKey = useMemo(() => `publish-${id}-${Date.now()}`, [id]);

  const selectedNames = groups.filter((g) => selected.has(g.id)).map((g) => g.name);

  const toggle = (gid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });

  const count = selected.size;
  const isLoading = !mock && groupsQuery.isLoading;
  const isError = !mock && groupsQuery.isError;

  const goPublished = () => {
    // §12 montage_published — montage id + group count only (no group names/content).
    if (id) trackMontagePublished({ montageId: id, groupCount: selected.size });
    router.replace({ pathname: '/(main)/today/published', params: { id, groups: selectedNames.join('•') } });
  };

  const onPublish = () => {
    if (mock || !id || count === 0) return;
    publish.mutate(
      { input: { groupIds: [...selected] }, idempotencyKey },
      {
        onSuccess: goPublished,
        onError: (err) => {
          // 409 → a recap for one of these groups already exists today → confirm replace.
          if (montageErrorStatus(err) === 409) setReplaceOpen(true);
        },
      },
    );
  };

  // Confirmed replace (Q2): supersede the prior recap with this one.
  const onConfirmReplace = () => {
    if (mock || !id || count === 0) return;
    replaceMutation.mutate(
      { input: { replacementMontageId: id, groupIds: [...selected] }, idempotencyKey: `${idempotencyKey}-replace` },
      {
        onSuccess: () => {
          setReplaceOpen(false);
          goPublished();
        },
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: 'Share to' }} />
      <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <Text style={{ ...theme.typography.title, color: c.text }}>Share to</Text>
        <Text style={{ ...theme.typography.body, color: c.muted }}>
          Pick the groups that see today’s recap. Live for 24 hours, then gone forever.
        </Text>

        {isLoading ? (
          <View style={{ gap: theme.spacing.sm }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} width="100%" height={66} radius={theme.radii.lg} />
            ))}
          </View>
        ) : isError ? (
          <ErrorRetry message={groupErrorMessage(groupsQuery.error)} onRetry={() => groupsQuery.refetch()} />
        ) : groups.length === 0 ? (
          <EmptyState
            icon="people-outline"
            title="No groups yet"
            body="Create or join a group first, then publish your recap to it."
            actionLabel="Go to groups"
            onAction={() => router.push('/(main)/groups')}
          />
        ) : (
          <View style={{ gap: theme.spacing.sm }}>
            {groups.map((g) => (
              <GroupSelectRow key={g.id} group={g} selected={selected.has(g.id)} onPress={() => toggle(g.id)} />
            ))}
          </View>
        )}
      </ScrollView>

      {groups.length > 0 ? (
        <View
          style={{
            padding: theme.spacing.lg,
            paddingBottom: insets.bottom + theme.spacing.md,
            borderTopWidth: 1,
            borderColor: c.border,
            backgroundColor: c.bg,
            gap: theme.spacing.sm,
          }}
        >
          {publish.isError ? (
            <Text style={{ ...theme.typography.caption, color: c.danger }}>{montageErrorMessage(publish.error)}</Text>
          ) : null}
          <Button
            label={count > 0 ? `Publish to ${count} group${count === 1 ? '' : 's'}` : 'Select a group'}
            icon="send"
            fullWidth
            size="lg"
            disabled={count === 0}
            loading={publish.isPending}
            onPress={onPublish}
          />
        </View>
      ) : null}

      <ReplaceConfirmSheet
        visible={replaceOpen}
        onClose={() => setReplaceOpen(false)}
        onConfirm={onConfirmReplace}
        loading={replaceMutation.isPending}
        groupNames={selectedNames}
      />
    </View>
  );
}

function GroupSelectRow({
  group,
  selected,
  onPress,
}: {
  group: GroupChoice;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        padding: theme.spacing.md,
        borderRadius: theme.radii.lg,
        borderWidth: 1.5,
        borderColor: selected ? c.accent : c.border,
        backgroundColor: selected ? c.accentSoft : c.surface,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Avatar name={group.name} uri={group.photoUrl ?? undefined} size={42} />
      <View style={{ flex: 1 }}>
        <Text style={{ ...theme.typography.bodyStrong, color: c.text }}>{group.name}</Text>
        <Text style={{ ...theme.typography.caption, color: c.muted }}>
          {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
        </Text>
      </View>
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: selected ? c.accent : 'transparent',
          borderWidth: selected ? 0 : 1.5,
          borderColor: c.faint,
        }}
      >
        {selected ? <Icon name="checkmark" size={15} color="#fff" /> : null}
      </View>
    </Pressable>
  );
}
