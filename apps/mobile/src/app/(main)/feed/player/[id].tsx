/**
 * 3.2 Player — DARK modal. Full-bleed 9:16 playback of a friend's recap with
 * sound (expo-video, tap-to-sound — device; web shows the thumbnail + a "plays
 * on the app" note). Author header + countdown, the optimistic reaction bar, and
 * a comments entry (→ 3.3). Forced-dark per the Ember prototype.
 *
 * The card is hydrated instantly from the feed cache (useFeedCard); web export
 * uses lib/feedMocks. Closing returns to the feed.
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { ForcedDarkProvider, useTheme } from '../../../../theme';
import { Avatar, CountdownBadge, EmptyState, Icon } from '../../../../ui';
import type { ReactionType } from '@twenty4/contracts/enums';
import { FeedVideo } from '../../../../features/feed/FeedVideo';
import { ReactionBar } from '../../../../features/feed/ReactionBar';
import { SafetySheet } from '../../../../features/feed/SafetySheet';
import { useFeedCard, useToggleReaction } from '../../../../lib/feed';
import { useMe } from '../../../../lib/groups';
import { feedMockActive, mockFeedCard, mockGroupLabel } from '../../../../lib/feedMocks';

function PlayerInner() {
  const theme = useTheme(); // forced dark
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const mock = feedMockActive();

  const cached = useFeedCard(id);
  const card = mock ? mockFeedCard(id) : cached;
  const me = useMe().data;
  const { toggle } = useToggleReaction(id ?? '∅');
  const [overflow, setOverflow] = useState(false);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(main)/feed');
  };

  if (!card) {
    return (
      <View style={{ flex: 1, backgroundColor: c.canvas, justifyContent: 'center' }}>
        <EmptyState
          icon="film-outline"
          title="This recap is gone"
          body="It may have expired or been removed. Recaps vanish after 24 hours."
          actionLabel="Back to feed"
          onAction={close}
        />
      </View>
    );
  }

  const onToggle = (type: ReactionType, current: ReactionType | null) => toggle(type, current);
  const groupLabel = mockGroupLabel(card.groupIds);

  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      {/* Full-bleed video */}
      <View style={{ position: 'absolute', inset: 0 }}>
        <FeedVideo
          videoUrl={card.videoUrl}
          thumbnailUrl={card.thumbnailUrl}
          variant="player"
          active
          onTapSound={() => undefined}
        />
      </View>

      {/* Top scrim + header */}
      <View
        style={{
          paddingTop: insets.top + theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: theme.spacing.lg,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: 'rgba(0,0,0,0.28)',
        }}
      >
        <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} onPress={close}>
          <Icon name="chevron-down" size={28} color="#fff" />
        </Pressable>
        <Avatar name={card.author.displayName} uri={card.author.profilePhotoUrl ?? undefined} size={36} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#fff', fontFamily: theme.fontFamily.bold, fontSize: 15 }} numberOfLines={1}>
            {card.author.displayName}
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontFamily: theme.fontFamily.medium, fontSize: 12 }} numberOfLines={1}>
            {groupLabel}
          </Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="More options" hitSlop={8} onPress={() => setOverflow(true)}>
          <Icon name="ellipsis-horizontal" size={22} color="#fff" />
        </Pressable>
      </View>

      <View style={{ flex: 1 }} />

      {/* Bottom controls: countdown + reactions + comments */}
      <View
        style={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.lg,
          gap: theme.spacing.md,
          backgroundColor: 'rgba(0,0,0,0.38)',
        }}
      >
        <CountdownBadge expiresAt={new Date(card.expiryAt).getTime()} />
        <ReactionBar summary={card.reactions} onToggle={onToggle} dark />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${card.commentCount} comments`}
          onPress={() => router.push(`/(main)/feed/comments/${card.montageId}`)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingVertical: 6,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Icon name="chatbubble-outline" size={20} color="#fff" />
          <Text style={{ color: '#fff', fontFamily: theme.fontFamily.semibold, fontSize: 15 }}>
            {card.commentCount === 0
              ? 'Add a comment'
              : card.commentCount === 1
                ? '1 comment'
                : `${card.commentCount} comments`}
          </Text>
          <View style={{ flex: 1 }} />
          <Icon name="chevron-forward" size={18} color="rgba(255,255,255,0.6)" />
        </Pressable>
      </View>

      {overflow ? (
        <SafetySheet
          visible={overflow}
          onClose={() => setOverflow(false)}
          montageId={card.montageId}
          authorId={card.author.id}
          authorName={card.author.displayName}
          isOwner={!!me && me.id === card.author.id}
          onDeleted={close}
          onDone={() => undefined}
        />
      ) : null}
    </View>
  );
}

export default function Player() {
  return (
    <ForcedDarkProvider>
      <Stack.Screen options={{ headerShown: false, presentation: 'fullScreenModal' }} />
      <PlayerInner />
    </ForcedDarkProvider>
  );
}
