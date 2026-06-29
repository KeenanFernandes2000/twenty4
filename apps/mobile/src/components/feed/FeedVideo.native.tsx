// FeedVideo (native) — the real on-device mp4 player via expo-video (SDK 56's
// modern player; expo-av is deprecated). Drives two modes from one component:
//   • feed card  — autoplay MUTED when on-screen (`active`), paused off-screen,
//     looping, no controls; the poster (thumbnail) shows until it's the active card.
//   • player     — `nativeControls` scrubber, sound on, no loop.
//
// Metro picks this file on iOS/Android; web + tsc use the base `FeedVideo.tsx`
// (which carries no native imports → the web export stays clean).
//
// expo-video 56.1.4: `useVideoPlayer(source, setup?)` → VideoPlayer with mutable
// `.muted` / `.loop` and `.play()` / `.pause()`; render `<VideoView player … />`.
import { useEffect } from 'react';
import { Image, Pressable, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useTheme } from '@/theme';
import type { FeedVideoProps } from './FeedVideo';

export function FeedVideo({
  uri,
  posterUri,
  active,
  muted,
  nativeControls = false,
  loop = true,
  contentFit = 'cover',
  onPress,
  style,
  testID = 'feed-video',
}: FeedVideoProps) {
  const theme = useTheme();

  // A null source is valid — the player simply has nothing to play until `uri`
  // resolves to the signed playback URL.
  const player = useVideoPlayer(uri ? { uri } : null, (p) => {
    p.loop = loop;
    p.muted = muted;
  });

  // Play in-view / pause off-screen. Calling play() on a muted player is what makes
  // autoplay allowed on web-like restrictions; on device it just starts the clip.
  useEffect(() => {
    if (!uri) return;
    if (active) player.play();
    else player.pause();
  }, [active, uri, player]);

  // Tap-for-sound: parent flips `muted`; mirror it onto the live player.
  useEffect(() => {
    player.muted = muted;
  }, [muted, player]);

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel="Open recap"
      testID={testID}
      style={[
        {
          width: '100%',
          aspectRatio: 9 / 16,
          borderRadius: theme.radii.lg,
          overflow: 'hidden',
          backgroundColor: theme.colors.canvas,
        },
        style,
      ]}
    >
      <VideoView
        player={player}
        nativeControls={nativeControls}
        contentFit={contentFit}
        style={{ width: '100%', height: '100%' }}
      />
      {/* Poster (thumbnail) overlays until this card is the active/playing one, so
          off-screen cards show a still rather than a black frame. */}
      {posterUri && !active ? (
        <Image
          source={{ uri: posterUri }}
          resizeMode={contentFit === 'cover' ? 'cover' : 'contain'}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
      ) : (
        <View pointerEvents="none" />
      )}
    </Pressable>
  );
}
