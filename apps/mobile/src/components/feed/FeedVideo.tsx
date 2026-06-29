// FeedVideo — type-facing + WEB/default implementation of the feed/player video.
//
// Metro resolves `./FeedVideo.native.tsx` on iOS/Android (the real expo-video
// player with in-view autoplay-muted + tap-for-sound); THIS module is what web +
// `expo export --platform web` use, and what TypeScript resolves as the contract
// both implementations satisfy.
//
// expo-video is a NATIVE module — keeping it out of this base file is what keeps
// the web export clean (mirrors components/montage/MontagePreview.tsx). On web we
// render a static 9:16 poster tile (the thumbnail) with a ▶ affordance — no
// autoplay, no sound — so the headless web build never touches a native module.
import { Image, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '@/ui';
import { useTheme } from '@/theme';

export interface FeedVideoProps {
  /** Signed GET URL of the rendered mp4 (null until ready). */
  uri: string | null;
  /** Thumbnail shown as the poster until/while not playing. */
  posterUri?: string | null;
  /** Native: play (muted preview) when true; pause when false. Ignored on web. */
  active: boolean;
  /** Native: mute toggle for the playing card / sound-on player. Ignored on web. */
  muted: boolean;
  /** Native: render the scrubber + transport controls (player screen). */
  nativeControls?: boolean;
  /** Native: loop the clip (feed preview loops; player does not). */
  loop?: boolean;
  contentFit?: 'cover' | 'contain';
  /** Tap handler (web ▶ + native tap-to-open-player). */
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function FeedVideo({ uri, posterUri, onPress, contentFit = 'cover', style, testID = 'feed-video' }: FeedVideoProps) {
  const theme = useTheme();

  const base: ViewStyle = {
    width: '100%',
    aspectRatio: 9 / 16,
    borderRadius: theme.radii.lg,
    overflow: 'hidden',
    backgroundColor: theme.colors.canvas,
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel="Open recap"
      testID={testID}
      style={[base, style]}
    >
      {posterUri ? (
        <Image
          source={{ uri: posterUri }}
          resizeMode={contentFit === 'cover' ? 'cover' : 'contain'}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
      ) : null}
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: theme.radii.full,
          backgroundColor: theme.colors.scrim,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text variant="title" color="onAccent">
          {'▶'}
        </Text>
      </View>
    </Pressable>
  );
}
