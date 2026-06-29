// (app)/feed — the block-filtered recap feed (M8 §6 3.1). A vertical FlatList of
// FeedCards over useInfiniteQuery (pages walk `nextCursor`). The on-screen card's
// video autoplays MUTED (viewability → `active`); off-screen cards pause. A group
// chip row scopes the feed to one group. Loading-skeleton / empty / error+retry
// states reuse the global QueryState components.
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View, type ViewToken } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { FeedCard as FeedCardDTO } from '@twenty4/contracts';
import { Screen, Spinner, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { EmptyState, ErrorRetry, ListSkeleton } from '@/components/QueryState';
import { useFeed } from '@/lib/feed';
import { FeedCard } from '@/components/feed/FeedCard';

// A small selectable filter pill (mirrors MontageReview's Chip idiom).
function FilterChip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      testID={testID}
      style={{
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.sm,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accentSoft : theme.colors.surface2,
      }}
    >
      <Text variant="caption" color={selected ? 'accent' : 'secondary'}>
        {label}
      </Text>
    </Pressable>
  );
}

export default function FeedScreen() {
  const theme = useTheme();
  const toast = useToast();

  const [group, setGroup] = useState<string | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(false);

  const feedQuery = useFeed(group);
  const groupsQuery = useQuery({ queryKey: queryKeys.groups.list, queryFn: () => api.listGroups() });

  const items: FeedCardDTO[] = feedQuery.data?.pages.flatMap((p) => p.items) ?? [];

  // New active card always starts muted (autoplay-muted; tap-for-sound re-enables).
  useEffect(() => {
    setSoundOn(false);
  }, [activeId]);

  // Viewability → the most-visible card is "active" (plays). Refs keep the handler +
  // config stable (RN throws if either prop identity changes between renders).
  const onViewRef = useRef((info: { viewableItems: ViewToken[] }) => {
    const first = info.viewableItems[0];
    const id = (first?.item as FeedCardDTO | undefined)?.montageId ?? null;
    setActiveId(id);
  });
  const viewConfigRef = useRef({ itemVisiblePercentThreshold: 60 });

  // Guarantee the top card plays even before the first viewability callback lands.
  const effectiveActiveId = activeId ?? items[0]?.montageId ?? null;

  const refreshControl = (
    <RefreshControl
      refreshing={feedQuery.isRefetching}
      onRefresh={() => {
        feedQuery.refetch().catch(() => toast.show({ type: 'error', message: 'Could not refresh' }));
      }}
      tintColor={theme.colors.accent}
      colors={[theme.colors.accent]}
    />
  );

  const groups = groupsQuery.data ?? [];

  const header = (
    <View style={{ paddingHorizontal: theme.spacing.xl }}>
      <ScreenHeader title="Feed" />
      {groups.length > 0 ? (
        <FlatList
          horizontal
          data={[{ id: undefined, name: 'All' }, ...groups.map((g) => ({ id: g.id as string | undefined, name: g.name }))]}
          keyExtractor={(it) => it.id ?? 'all'}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.spacing.sm, paddingBottom: theme.spacing.base }}
          renderItem={({ item }) => (
            <FilterChip
              label={item.name}
              selected={group === item.id}
              onPress={() => setGroup(item.id)}
              testID={`feed-filter-${item.id ?? 'all'}`}
            />
          )}
        />
      ) : null}
    </View>
  );

  // ── Body: loading / error / empty / list ──────────────────────────────────
  const renderBody = () => {
    if (feedQuery.isLoading) {
      return (
        <View style={{ paddingHorizontal: theme.spacing.xl, paddingTop: theme.spacing.base }}>
          <ListSkeleton count={3} />
        </View>
      );
    }
    if (feedQuery.isError) {
      return (
        <ErrorRetry
          onRetry={() => void feedQuery.refetch()}
          error={feedQuery.error}
          retrying={feedQuery.isFetching}
        />
      );
    }
    if (items.length === 0) {
      return (
        <EmptyState
          title="Nothing in the feed yet"
          subtitle="When your friends publish a recap, it shows up here for 24 hours."
        />
      );
    }
    return (
      <FlatList
        testID="feed-list"
        data={items}
        keyExtractor={(it) => it.montageId}
        renderItem={({ item }) => (
          <FeedCard
            card={item}
            active={item.montageId === effectiveActiveId}
            soundOn={soundOn}
            onToggleSound={() => setSoundOn((s) => !s)}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: theme.spacing.lg }} />}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingTop: theme.spacing.base,
          paddingBottom: theme.spacing.section,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={refreshControl}
        onViewableItemsChanged={onViewRef.current}
        viewabilityConfig={viewConfigRef.current}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (feedQuery.hasNextPage && !feedQuery.isFetchingNextPage) void feedQuery.fetchNextPage();
        }}
        ListFooterComponent={
          feedQuery.isFetchingNextPage ? (
            <View style={{ paddingVertical: theme.spacing.xl, alignItems: 'center' }}>
              <Spinner />
            </View>
          ) : null
        }
      />
    );
  };

  return (
    <Screen padded={false}>
      <View style={{ flex: 1 }} testID="feed-screen">
        {header}
        {renderBody()}
      </View>
    </Screen>
  );
}
