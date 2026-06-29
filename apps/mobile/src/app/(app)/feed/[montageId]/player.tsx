// (app)/feed/[montageId]/player — full-screen 9:16 playback with SOUND ON + a
// scrubber (M8 §6 3.2). Reached from a feed card, so the card lives in the feed
// cache; useFeedCard reads it reactively (react bar stays in lockstep with the
// shared optimistic patch). Native uses the expo-video scrubber (`nativeControls`);
// the web export degrades to the poster + a "open mp4" affordance (no native
// module) so `expo export --platform web` stays clean.
import { Linking, Platform, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { ReactionType } from '@twenty4/contracts';
import { Button, Screen, Text } from '@/ui';
import { useTheme } from '@/theme';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { useFeedCard, useReact } from '@/lib/feed';
import { FeedVideo } from '@/components/feed/FeedVideo';
import { ExpiryCountdown } from '@/components/feed/ExpiryCountdown';
import { ReactionBar } from '@/components/feed/ReactionBar';

export default function PlayerScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { montageId } = useLocalSearchParams<{ montageId: string }>();
  const card = useFeedCard(montageId);
  const react = useReact();

  const goFeed = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(app)/feed');
  };

  // Cache miss (cold deep-link), OR the recap expired while cached (M9 — its signed
  // URL now 404s, and the server has dropped it from the feed). Either way there's
  // nothing to play, so guide back to the feed instead of choking on a dead URL.
  const expired = !!card && new Date(card.expiryAt).getTime() <= Date.now();
  if (!card || expired) {
    return (
      <Screen>
        <ScreenHeader title="Recap" onBack={goFeed} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.xl }}>
          <Text variant="title" align="center">
            {expired ? 'This recap has expired' : 'This recap isn’t available'}
          </Text>
          <Button variant="secondary" title="Back to feed" onPress={goFeed} testID="player-back" />
        </View>
      </Screen>
    );
  }

  const onReact = (type: ReactionType) =>
    react.mutate({ montageId: card.montageId, type, current: card.viewerReaction });

  // Web-only ▶ affordance opens the signed mp4 in a new tab; native uses controls.
  const onWebOpen =
    Platform.OS === 'web' && card.videoUrl
      ? () => void Linking.openURL(card.videoUrl as string).catch(() => {})
      : undefined;

  return (
    <Screen padded={false}>
      <View style={{ flex: 1 }} testID="player-screen">
        <View style={{ paddingHorizontal: theme.spacing.xl }}>
          <ScreenHeader title={card.author.displayName ?? 'Recap'} onBack={goFeed} />
        </View>

        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: theme.spacing.xl }}>
          <FeedVideo
            uri={card.videoUrl}
            posterUri={card.thumbnailUrl}
            active
            muted={false}
            loop={false}
            nativeControls
            contentFit="contain"
            onPress={onWebOpen}
            style={{ maxHeight: '88%' }}
            testID="player-video"
          />
        </View>

        <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.xl, gap: theme.spacing.base }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <ExpiryCountdown expiryAt={card.expiryAt} variant="caption" />
            {card.reactionCount > 0 ? (
              <Text variant="caption" color="muted">
                {card.reactionCount} reaction{card.reactionCount === 1 ? '' : 's'}
              </Text>
            ) : null}
          </View>
          <ReactionBar
            viewerReaction={card.viewerReaction}
            onReact={onReact}
            disabled={react.isPending}
            testIDPrefix="player-react"
          />
          <Button
            variant="secondary"
            fullWidth
            title={card.commentCount > 0 ? `Comments · ${card.commentCount}` : 'Add a comment'}
            onPress={() => router.push(`/(app)/feed/${card.montageId}/comments`)}
            testID="player-comments"
          />
        </View>
      </View>
    </Screen>
  );
}
