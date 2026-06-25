// CaptureThumbStrip — a small horizontal strip of just-captured thumbnails for the
// camera screen. Shows the assets captured this session (by their local uri) as they
// get enqueued. Scrollable, compact. Renders nothing when empty.
//
// Takes plain UploadAssets (the camera screen keeps a local session array) so it has
// no coupling to the upload store or expo modules.
import { Image, ScrollView, View } from 'react-native';
import { Text } from '@/ui';
import { useTheme } from '@/theme';
import type { UploadAsset } from '@/stores/uploadStore';

export function CaptureThumbStrip({ assets }: { assets: UploadAsset[] }) {
  const theme = useTheme();
  if (assets.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="capture-strip"
      contentContainerStyle={{ gap: theme.spacing.sm, paddingHorizontal: theme.spacing.xs }}
    >
      {assets.map((a, i) => (
        <View
          key={`${a.uri}-${i}`}
          style={{
            width: 48,
            height: 48,
            borderRadius: theme.radii.sm,
            overflow: 'hidden',
            backgroundColor: theme.colors.surface2,
            borderWidth: 1,
            borderColor: theme.colors.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Image
            source={{ uri: a.uri }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
          {a.mediaType === 'video' ? (
            <View
              style={{
                position: 'absolute',
                inset: 0,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.colors.scrim,
              }}
            >
              <Text variant="micro" color="onAccent">
                {'▶'}
              </Text>
            </View>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}
