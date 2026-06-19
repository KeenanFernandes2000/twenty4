/**
 * MontagePlayer — WEB. Device autoplay+sound is device-verified, so the web
 * export shows the montage thumbnail (or a placeholder) inside the same 9:16
 * frame instead of pulling expo-video into the web bundle. A play affordance +
 * "preview on the app" note make the device-only nature obvious. Used for the
 * 2.5 Review screenshots.
 */
import { Image, Text, View } from 'react-native';

import { useTheme } from '../../theme';
import { Icon } from '../../ui';
import type { MontagePlayerProps } from './MontagePlayer';

export function MontagePlayer({ thumbnailUrl, state = 'draft', height = 300 }: MontagePlayerProps) {
  const theme = useTheme();
  const c = theme.colors;

  return (
    <View style={{ height, borderRadius: theme.radii.xl, overflow: 'hidden', backgroundColor: c.vid[1] }}>
      {thumbnailUrl ? (
        <Image source={{ uri: thumbnailUrl }} style={{ flex: 1 }} resizeMode="cover" />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="film-outline" size={40} color={c.faint} />
        </View>
      )}

      {/* Dim scrim so the play button + badge read on any thumbnail. */}
      <View style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.28)' }} />

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

      <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
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
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontFamily: theme.fontFamily.semibold, fontSize: 11 }}>
          Preview plays on the app
        </Text>
      </View>
    </View>
  );
}
