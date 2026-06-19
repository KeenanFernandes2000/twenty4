/**
 * MontagePlayer — NATIVE (iOS/Android). Plays the draft/published montage with
 * expo-video. Video autoplay+sound is device-verified, so this variant only
 * ships to the native bundle; web resolves to MontagePlayer.web.tsx (a thumbnail
 * / placeholder), keeping expo-video out of the web export.
 *
 * 9:16 surface with a DRAFT/LIVE badge, a play/pause tap target, and a position
 * read-out. The parent owns the chrome (theme/music/publish); this is just the
 * frame + playback.
 */
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';

import { useTheme } from '../../theme';
import { Icon } from '../../ui';

export interface MontagePlayerProps {
  videoUrl?: string | null;
  thumbnailUrl?: string | null;
  /** 'draft' shows a DRAFT pip; 'published' shows LIVE. */
  state?: 'draft' | 'published';
  height?: number;
}

export function MontagePlayer({ videoUrl, thumbnailUrl, state = 'draft', height = 300 }: MontagePlayerProps) {
  const theme = useTheme();
  const c = theme.colors;

  const player = useVideoPlayer(videoUrl ?? '', (p) => {
    p.loop = true;
    p.muted = false;
  });
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const sub = player.addListener('playingChange', (e) => setPlaying(e.isPlaying));
    return () => sub.remove();
  }, [player]);

  const toggle = () => {
    if (playing) player.pause();
    else player.play();
  };

  return (
    <View style={{ height, borderRadius: theme.radii.xl, overflow: 'hidden', backgroundColor: c.vid[1] }}>
      {videoUrl ? (
        <VideoView player={player} style={{ flex: 1 }} contentFit="cover" nativeControls={false} />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="film-outline" size={40} color={c.faint} />
        </View>
      )}

      {/* Badge */}
      <View
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingVertical: 5,
          paddingHorizontal: 11,
          borderRadius: theme.radii.pill,
          backgroundColor: 'rgba(0,0,0,0.4)',
        }}
      >
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: state === 'published' ? c.success : c.accent2 }} />
        <Text style={{ color: '#fff', fontFamily: theme.fontFamily.bold, fontSize: 11 }}>
          {state === 'published' ? 'LIVE' : 'DRAFT'}
        </Text>
      </View>

      {/* Play/pause tap */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pause' : 'Play'}
        onPress={toggle}
        style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}
      >
        {!playing ? (
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: 'rgba(255,255,255,0.2)',
              borderWidth: 1.5,
              borderColor: 'rgba(255,255,255,0.6)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="play" size={26} color="#fff" />
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}
