// MontagePreview — type-facing + WEB/default implementation of the montage mp4
// preview. Metro resolves `./MontagePreview.native.tsx` on iOS/Android (the real
// expo-video player); THIS module is what web + `expo export --platform web` use,
// and what TypeScript resolves as the contract both implementations satisfy.
//
// expo-video is a NATIVE module — keeping it out of this base file is what makes
// the web export succeed (mirrors how camera.tsx gates recordAsync to native).
// On web we render a graceful 9:16 poster tile with a play affordance that opens
// the signed previewUrl in a new tab (the produced mp4 still plays on-device in
// Expo Go via the native variant).
import { Linking, Pressable, View } from 'react-native';
import { Text } from '@/ui';
import { useTheme } from '@/theme';

export interface MontagePreviewProps {
  /** Signed GET URL of the rendered mp4 (null until status=draft_ready). */
  uri: string | null;
  testID?: string;
}

export function MontagePreview({ uri, testID = 'montage-preview' }: MontagePreviewProps) {
  const theme = useTheme();

  const open = () => {
    if (uri) void Linking.openURL(uri).catch(() => {});
  };

  return (
    <Pressable
      onPress={open}
      disabled={!uri}
      accessibilityRole="button"
      accessibilityLabel="Play montage preview"
      testID={testID}
      style={{
        width: '100%',
        aspectRatio: 9 / 16,
        maxHeight: 420,
        alignSelf: 'center',
        borderRadius: theme.radii.lg,
        overflow: 'hidden',
        backgroundColor: theme.colors.canvas,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.base,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text variant="display" color="onAccent">
        {'▶'}
      </Text>
      <Text variant="caption" color="muted" align="center" style={{ paddingHorizontal: theme.spacing.xl }}>
        {uri ? 'Tap to play your montage' : 'Preparing preview…'}
      </Text>
    </Pressable>
  );
}
