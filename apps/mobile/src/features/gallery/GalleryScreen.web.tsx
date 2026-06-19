/**
 * 2.3 Gallery pick — WEB stub.
 *
 * Library picking with EXIF/asset metadata (expo-image-picker + media-library)
 * is device-only. On web we render a notice rather than importing the native
 * pickers, keeping `expo export -p web` clean. Real impl in gallery.tsx (native).
 */
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen } from '../../components/Screen';
import { Button, EmptyState } from '../../ui';

export default function GalleryWeb() {
  const router = useRouter();
  return (
    <Screen center>
      <View style={{ gap: 16, alignItems: 'center' }}>
        <EmptyState
          icon="images-outline"
          title="Add from your library"
          body="Picking today’s photos & videos (with capture-time metadata) runs on the twenty4 mobile app."
        />
        <Button label="Back to Today" variant="secondary" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}
