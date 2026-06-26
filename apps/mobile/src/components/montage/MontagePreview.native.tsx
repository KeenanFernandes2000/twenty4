// MontagePreview (native) — the real on-device mp4 player via expo-video
// (SDK 56's modern player; expo-av is deprecated). Plays the produced 1080×1920
// h264 montage inline on the review screen in Expo Go. Metro picks this file on
// iOS/Android; web + tsc use the base `MontagePreview.tsx` contract.
//
// expo-video 56.1.4: `useVideoPlayer(source, setup?)` → VideoPlayer; render with
// `<VideoView player={player} nativeControls contentFit />`. Source accepts a
// `{ uri }` object or a bare URL string.
import { useVideoPlayer, VideoView } from 'expo-video';
import { View } from 'react-native';
import { Text } from '@/ui';
import { useTheme } from '@/theme';
import type { MontagePreviewProps } from './MontagePreview';

export function MontagePreview({ uri, testID = 'montage-preview' }: MontagePreviewProps) {
  const theme = useTheme();

  // A null source is valid — the player simply has nothing to play until the
  // render lands and `uri` becomes the signed previewUrl.
  const player = useVideoPlayer(uri ? { uri } : null, (p) => {
    p.loop = false;
    p.muted = false;
  });

  if (!uri) {
    return (
      <View
        testID={testID}
        style={{
          width: '100%',
          aspectRatio: 9 / 16,
          maxHeight: 420,
          alignSelf: 'center',
          borderRadius: theme.radii.lg,
          backgroundColor: theme.colors.canvas,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: theme.colors.border,
        }}
      >
        <Text variant="caption" color="muted">
          Preparing preview…
        </Text>
      </View>
    );
  }

  return (
    <VideoView
      testID={testID}
      player={player}
      nativeControls
      contentFit="contain"
      style={{
        width: '100%',
        aspectRatio: 9 / 16,
        maxHeight: 420,
        alignSelf: 'center',
        borderRadius: theme.radii.lg,
        overflow: 'hidden',
        backgroundColor: theme.colors.canvas,
      }}
    />
  );
}
