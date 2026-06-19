/**
 * FeedVideo — WEB. Autoplay-muted previews + tap-to-sound playback are
 * device-verified, so the web export shows the montage thumbnail (or a
 * placeholder) inside the same frame instead of pulling expo-video into the web
 * bundle. A muted pip (card) or a play affordance + "preview on the app" note
 * (player) make the device-only nature obvious. Used for the 3.1/3.2 screenshots.
 */
import { Image, Text, View } from 'react-native';

import { useTheme } from '../../theme';
import { Icon } from '../../ui';
import type { FeedVideoProps } from './FeedVideo';

export function FeedVideo({ thumbnailUrl, variant = 'card' }: FeedVideoProps) {
  const theme = useTheme();
  const c = theme.colors;
  const isCard = variant === 'card';

  return (
    <View style={{ flex: 1, backgroundColor: c.vid[1] }}>
      {thumbnailUrl ? (
        <Image source={{ uri: thumbnailUrl }} style={{ flex: 1 }} resizeMode="cover" />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="film-outline" size={40} color={c.faint} />
        </View>
      )}

      {/* Dim scrim so overlays read on any thumbnail. */}
      <View style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.22)' }} />

      {isCard ? (
        <View
          style={{
            position: 'absolute',
            bottom: 12,
            right: 12,
            width: 30,
            height: 30,
            borderRadius: 15,
            backgroundColor: 'rgba(0,0,0,0.45)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="volume-mute" size={16} color="#fff" />
        </View>
      ) : (
        <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: 'rgba(255,255,255,0.2)',
              borderWidth: 1.5,
              borderColor: 'rgba(255,255,255,0.6)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="play" size={30} color="#fff" />
          </View>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontFamily: theme.fontFamily.semibold, fontSize: 11 }}>
            Tap to play with sound on the app
          </Text>
        </View>
      )}
    </View>
  );
}
