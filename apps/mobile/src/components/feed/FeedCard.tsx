// FeedCard — one recap in the vertical feed (M8 §6 3.1). Author + recap date + a
// live expiry countdown, the 9:16 video (autoplay-muted in-view via the
// platform-split FeedVideo, tap-to-open-player, native tap-for-sound), the 5-emoji
// reaction bar + count, the comment count + 2-latest preview, and the
// report/delete AFFORDANCES (write endpoints are M12 → these are no-op "coming
// soon" for now; the flags `canDelete`/`canReport` decide which one shows).
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { FeedCard as FeedCardDTO, ReactionType } from '@twenty4/contracts';
import { Avatar, Card, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { useReact } from '@/lib/feed';
import { FeedVideo } from './FeedVideo';
import { ExpiryCountdown } from './ExpiryCountdown';
import { ReactionBar } from './ReactionBar';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "YYYY-MM-DD" → "May 25" (display-only; falls back to the raw string).
function formatDayBucket(s: string): string {
  const parts = s.split('-').map(Number);
  const [y, m, d] = parts;
  if (!y || !m || !d) return s;
  return `${MONTHS[m - 1] ?? ''} ${d}`.trim();
}

export function FeedCard({
  card,
  active,
  soundOn,
  onToggleSound,
}: {
  card: FeedCardDTO;
  /** This card is on-screen → its video autoplays (native). */
  active: boolean;
  /** The active card's sound state (tap-for-sound). Ignored when not active. */
  soundOn: boolean;
  onToggleSound: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const react = useReact();

  const onReact = (type: ReactionType) =>
    react.mutate({ montageId: card.montageId, type, current: card.viewerReaction });

  const openPlayer = () => router.push(`/(app)/feed/${card.montageId}/player`);
  const openComments = () => router.push(`/(app)/feed/${card.montageId}/comments`);

  // Report/delete are M12 write endpoints — render the affordance, no-op for now.
  const comingSoon = (what: string) => toast.show({ type: 'info', message: `${what} is coming soon` });

  const name = card.author.displayName ?? 'Someone';
  const showSoundToggle = Platform.OS !== 'web' && active && !!card.videoUrl;

  return (
    <Card variant="compact">
      <View style={{ gap: theme.spacing.base }} testID={`feed-card-${card.montageId}`}>
        {/* ── Header: author + date + expiry + affordance ─────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.base }}>
          <Avatar size="sm" uri={card.author.avatarUrl ?? undefined} name={name} />
          <View style={{ flex: 1 }}>
            <Text variant="body" numberOfLines={1}>
              {name}
            </Text>
            <Text variant="caption" color="muted">
              {formatDayBucket(card.dayBucket)}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: theme.spacing.xxs }}>
            <ExpiryCountdown expiryAt={card.expiryAt} testID={`feed-expiry-${card.montageId}`} />
            {card.canDelete ? (
              <Pressable onPress={() => comingSoon('Delete')} hitSlop={8} testID={`feed-delete-${card.montageId}`}>
                <Text variant="caption" color="danger">
                  Delete
                </Text>
              </Pressable>
            ) : card.canReport ? (
              <Pressable onPress={() => comingSoon('Report')} hitSlop={8} testID={`feed-report-${card.montageId}`}>
                <Text variant="caption" color="muted">
                  Report
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* ── Video (in-view autoplay-muted; tap opens the sound-on player) ──── */}
        <View>
          <FeedVideo
            uri={card.videoUrl}
            posterUri={card.thumbnailUrl}
            active={active}
            muted={!soundOn}
            loop
            contentFit="cover"
            onPress={openPlayer}
            testID={`feed-video-${card.montageId}`}
          />
          {showSoundToggle ? (
            <Pressable
              onPress={onToggleSound}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={soundOn ? 'Mute' : 'Unmute'}
              testID={`feed-sound-${card.montageId}`}
              style={{
                position: 'absolute',
                bottom: theme.spacing.md,
                right: theme.spacing.md,
                width: 36,
                height: 36,
                borderRadius: theme.radii.full,
                backgroundColor: theme.colors.scrim,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text variant="caption" color="onAccent">
                {soundOn ? '🔊' : '🔇'}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {/* ── Reaction bar + count ──────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.base }}>
          <ReactionBar
            viewerReaction={card.viewerReaction}
            onReact={onReact}
            disabled={react.isPending}
            testIDPrefix={`feed-react-${card.montageId}`}
          />
          {card.reactionCount > 0 ? (
            <Text variant="caption" color="muted" testID={`feed-reaction-count-${card.montageId}`}>
              {card.reactionCount}
            </Text>
          ) : null}
        </View>

        {/* ── Comments: count + 2-latest preview ────────────────────────────── */}
        <Pressable onPress={openComments} testID={`feed-comments-${card.montageId}`}>
          <View style={{ gap: theme.spacing.xs }}>
            {card.commentPreview.map((c) => (
              <Text key={c.id} variant="caption" color="secondary" numberOfLines={1}>
                <Text variant="caption" color="primary">
                  {c.author.displayName ?? 'Someone'}
                </Text>
                {`  ${c.text}`}
              </Text>
            ))}
            <Text variant="caption" color="accent">
              {card.commentCount === 0
                ? 'Add a comment'
                : card.commentCount <= card.commentPreview.length
                  ? 'View comments'
                  : `View all ${card.commentCount} comments`}
            </Text>
          </View>
        </Pressable>
      </View>
    </Card>
  );
}
