/**
 * FeedCard — a single 3.1 feed card. An autoplay-muted looping 9:16 preview
 * (FeedVideo; device — web shows the thumbnail), the author + group label, a 24h
 * CountdownBadge, the five-reaction bar (optimistic), a comment-count button
 * (opens 3.3), and a "⋯" overflow (report/block/owner-delete). Tapping the
 * preview opens the 3.2 player.
 */
import { Pressable, Text, View } from 'react-native';

import { useTheme } from '../../theme';
import { Avatar, CountdownBadge, Icon } from '../../ui';
import type { FeedCard as FeedCardData } from '@twenty4/contracts/dto';
import type { ReactionType } from '@twenty4/contracts/enums';
import { FeedVideo } from './FeedVideo';
import { ReactionBar } from './ReactionBar';

export interface FeedCardProps {
  card: FeedCardData;
  groupLabel: string;
  active?: boolean;
  onOpenPlayer: () => void;
  onOpenComments: () => void;
  onToggleReaction: (type: ReactionType, current: ReactionType | null) => void;
  onOverflow: () => void;
}

export function FeedCard({
  card,
  groupLabel,
  active = true,
  onOpenPlayer,
  onOpenComments,
  onToggleReaction,
  onOverflow,
}: FeedCardProps) {
  const theme = useTheme();
  const c = theme.colors;

  return (
    <View
      style={{
        backgroundColor: c.surface,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: theme.radii.lg,
        overflow: 'hidden',
        marginBottom: theme.spacing.lg,
      }}
    >
      {/* Header: author + group + overflow */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingVertical: theme.spacing.md,
          paddingHorizontal: theme.spacing.lg,
        }}
      >
        <Avatar name={card.author.displayName} uri={card.author.profilePhotoUrl ?? undefined} size={38} />
        <View style={{ flex: 1 }}>
          <Text style={{ ...theme.typography.bodyStrong, color: c.text }} numberOfLines={1}>
            {card.author.displayName}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Icon name="people" size={12} color={c.muted} />
            <Text style={{ ...theme.typography.caption, color: c.muted }} numberOfLines={1}>
              {groupLabel}
            </Text>
          </View>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="More options"
          hitSlop={8}
          onPress={onOverflow}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, padding: 4 })}
        >
          <Icon name="ellipsis-horizontal" size={20} color={c.muted} />
        </Pressable>
      </View>

      {/* 9:16 autoplay-muted preview → opens player */}
      <Pressable accessibilityRole="button" accessibilityLabel="Open recap" onPress={onOpenPlayer}>
        <View style={{ aspectRatio: 9 / 16, width: '100%' }}>
          <FeedVideo
            videoUrl={card.videoUrl}
            thumbnailUrl={card.thumbnailUrl}
            variant="card"
            active={active}
          />
          {/* Countdown overlay top-right */}
          <View style={{ position: 'absolute', top: 12, right: 12 }}>
            <CountdownBadge expiresAt={new Date(card.expiryAt).getTime()} />
          </View>
        </View>
      </Pressable>

      {/* Footer: reactions + comment count */}
      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
        <ReactionBar summary={card.reactions} onToggle={onToggleReaction} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${card.commentCount} comments`}
          onPress={onOpenComments}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon name="chatbubble-outline" size={18} color={c.muted} />
          <Text style={{ ...theme.typography.bodyStrong, color: c.text2 }}>
            {card.commentCount === 0
              ? 'Add a comment'
              : card.commentCount === 1
                ? '1 comment'
                : `${card.commentCount} comments`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
