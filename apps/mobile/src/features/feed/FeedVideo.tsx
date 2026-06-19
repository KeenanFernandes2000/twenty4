/**
 * FeedVideo — NATIVE (iOS/Android). The autoplay-MUTED, looping preview behind a
 * 3.1 feed card and the full-sound playback in the 3.2 player. expo-video only
 * ships to the native bundle; web resolves to FeedVideo.web.tsx (a thumbnail /
 * placeholder), keeping expo-video out of the web export.
 *
 *   - variant 'card'   → autoplay, muted, loop. A muted-speaker pip hints that
 *     tapping into the player unlocks sound. Autoplay is device-verified.
 *   - variant 'player' → starts playing; `tapToSound` toggles mute on tap
 *     (device-verified). A play/pause overlay appears while paused.
 */
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';

import { useTheme } from '../../theme';
import { Icon } from '../../ui';

export interface FeedVideoProps {
  videoUrl?: string | null;
  thumbnailUrl?: string | null;
  variant?: 'card' | 'player';
  /** Card previews autoplay when on-screen; pass false to pause off-screen cards. */
  active?: boolean;
  /** Player: tap toggles mute (device). */
  onTapSound?: (muted: boolean) => void;
}

export function FeedVideo({
  videoUrl,
  variant = 'card',
  active = true,
  onTapSound,
}: FeedVideoProps) {
  const theme = useTheme();
  const c = theme.colors;
  const isCard = variant === 'card';

  const player = useVideoPlayer(videoUrl ?? '', (p) => {
    p.loop = true;
    p.muted = isCard; // cards start muted; the player starts with sound
  });
  const [muted, setMuted] = useState(isCard);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const sub = player.addListener('playingChange', (e) => setPlaying(e.isPlaying));
    return () => sub.remove();
  }, [player]);

  // Card autoplay is gated on `active` (visible on screen) to save battery/data.
  useEffect(() => {
    if (!videoUrl) return;
    if (isCard) {
      if (active) player.play();
      else player.pause();
    } else {
      player.play();
    }
  }, [player, videoUrl, isCard, active]);

  const onPress = () => {
    if (isCard) return; // card taps are handled by the parent (open player)
    if (onTapSound) {
      const next = !muted;
      player.muted = next;
      setMuted(next);
      onTapSound(next);
    } else {
      if (playing) player.pause();
      else player.play();
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.vid[1] }}>
      {videoUrl ? (
        <VideoView player={player} style={{ flex: 1 }} contentFit="cover" nativeControls={false} />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="film-outline" size={40} color={c.faint} />
        </View>
      )}

      {/* Card: muted-speaker pip (tap card to open + hear). */}
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={muted ? 'Tap to unmute' : 'Tap to mute'}
          onPress={onPress}
          style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}
        >
          {!playing ? (
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
          ) : (
            <View
              style={{
                position: 'absolute',
                bottom: 16,
                right: 16,
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: 'rgba(0,0,0,0.45)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name={muted ? 'volume-mute' : 'volume-high'} size={18} color="#fff" />
            </View>
          )}
        </Pressable>
      )}
    </View>
  );
}
