/**
 * 3.1 Feed — today's published recaps from the caller's member groups.
 *
 * useFeed INFINITE (10/page §10): a FlatList of FeedCards with autoplay-muted
 * looping previews (device; web shows the thumbnail), a 24h CountdownBadge,
 * the optimistic five-reaction bar, a comment-count button (→ 3.3), and a "⋯"
 * overflow (report/block/owner-delete). Pull-to-refresh resets to page 0;
 * scroll-end fetches the next page. Empty state + skeletons.
 *
 * Web-safe: the real infinite query runs on a device; the web export renders the
 * SAME screen against lib/feedMocks (driven by globalThis.__TWENTY4_FEED_MOCK__)
 * so the orchestrator can screenshot the populated + empty states in light/dark.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { useTheme } from '../../../theme';
import { EmptyState, ErrorRetry, Skeleton } from '../../../ui';
import { toast } from '../../../stores/toastStore';
import type { FeedCard as FeedCardData } from '@twenty4/contracts/dto';
import type { ReactionType } from '@twenty4/contracts/enums';
import { FeedCard } from '../../../features/feed/FeedCard';
import { SafetySheet } from '../../../features/feed/SafetySheet';
import { useFeed, flattenFeed, useToggleReaction, feedErrorMessage } from '../../../lib/feed';
import { useMe } from '../../../lib/groups';
import { trackFeedViewed, trackReactionSent } from '../../../lib/analytics';
import { feedMockActive, mockFeedCards, mockGroupLabel } from '../../../lib/feedMocks';

/** A card wrapper so each card owns its own reaction-toggle hook (id varies). */
function FeedCardItem({
  card,
  active,
  onOverflow,
}: {
  card: FeedCardData;
  active: boolean;
  onOverflow: (card: FeedCardData) => void;
}) {
  const router = useRouter();
  const { toggle } = useToggleReaction(card.montageId);
  const groupLabel = useMemo(() => mockGroupLabel(card.groupIds), [card.groupIds]);

  const onToggle = useCallback(
    (type: ReactionType, current: ReactionType | null) => {
      // §12 reaction_sent — montage id + reaction enum only. Emit only when SETTING
      // a reaction (not when clearing one): current !== type means a new reaction.
      if (current !== type) trackReactionSent({ montageId: card.montageId, reactionType: type });
      toggle(type, current);
    },
    [toggle, card.montageId],
  );

  return (
    <FeedCard
      card={card}
      groupLabel={groupLabel}
      active={active}
      onOpenPlayer={() => router.push(`/(main)/feed/player/${card.montageId}`)}
      onOpenComments={() => router.push(`/(main)/feed/comments/${card.montageId}`)}
      onToggleReaction={onToggle}
      onOverflow={() => onOverflow(card)}
    />
  );
}

export default function Feed() {
  const theme = useTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const mock = feedMockActive();

  const query = useFeed({ enabled: !mock });
  const me = useMe().data;

  const cards = mock ? mockFeedCards() : flattenFeed(query.data);
  const [refreshing, setRefreshing] = useState(false);
  const [overflowCard, setOverflowCard] = useState<FeedCardData | null>(null);

  const onRefresh = useCallback(async () => {
    if (mock) return;
    setRefreshing(true);
    try {
      await query.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [mock, query]);

  const onEndReached = useCallback(() => {
    if (mock) return;
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [mock, query]);

  // Route feed toasts through the GLOBAL toast host (mounted once in the root
  // layout) so there's a single toast surface app-wide.
  const showToast = useCallback((msg: string) => toast.success(msg), []);

  // §12 feed_viewed — fired once per feed open (the global/all-groups view → no
  // groupId). Content-free.
  useEffect(() => {
    trackFeedViewed();
  }, []);

  const isLoading = !mock && query.isLoading;
  const isError = !mock && query.isError;

  // Loading skeletons.
  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, padding: theme.spacing.lg, gap: theme.spacing.lg }}>
        {[0, 1].map((i) => (
          <View
            key={i}
            style={{
              backgroundColor: c.surface,
              borderColor: c.border,
              borderWidth: 1,
              borderRadius: theme.radii.lg,
              overflow: 'hidden',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: theme.spacing.lg }}>
              <Skeleton width={38} height={38} radius={19} />
              <View style={{ gap: 6 }}>
                <Skeleton width={120} height={14} />
                <Skeleton width={80} height={11} />
              </View>
            </View>
            <Skeleton width="100%" height={320} radius={0} />
            <View style={{ padding: theme.spacing.lg, gap: 10 }}>
              <Skeleton width={200} height={30} radius={theme.radii.pill} />
              <Skeleton width={120} height={14} />
            </View>
          </View>
        ))}
      </View>
    );
  }

  if (isError) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center' }}>
        <ErrorRetry message={feedErrorMessage(query.error)} onRetry={() => void query.refetch()} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* Header */}
      <View
        style={{
          paddingTop: insets.top + theme.spacing.sm,
          paddingBottom: theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          backgroundColor: c.surface,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Text style={{ ...theme.typography.heading, color: c.text, flex: 1 }}>Feed</Text>
        <Text style={{ ...theme.typography.caption, color: c.muted }}>Gone in 24h</Text>
      </View>

      <FlatList
        data={cards}
        keyExtractor={(item) => item.montageId}
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xl,
          flexGrow: 1,
        }}
        renderItem={({ item, index }) => (
          <FeedCardItem card={item} active={index < 2} onOverflow={setOverflowCard} />
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />
        }
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: 'center', minHeight: 480 }}>
            <EmptyState
              icon="albums-outline"
              title="Nothing today — yet"
              body="When friends in your groups publish their recap, it shows up here. They vanish after 24 hours."
            />
          </View>
        }
      />

      {overflowCard ? (
        <SafetySheet
          visible={!!overflowCard}
          onClose={() => setOverflowCard(null)}
          montageId={overflowCard.montageId}
          authorId={overflowCard.author.id}
          authorName={overflowCard.author.displayName}
          isOwner={!!me && me.id === overflowCard.author.id}
          onDeleted={() => showToast('Recap deleted.')}
          onDone={showToast}
        />
      ) : null}
    </View>
  );
}
