/**
 * 2.2 Camera — WEB stub.
 *
 * In-app capture is device-only (expo-camera + background upload). On web we
 * render a clear "open on your phone" notice instead of pulling the native
 * camera module, so `expo export -p web` stays clean. The real implementation
 * is in camera.tsx (native), selected by Metro on iOS/Android.
 */
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { ForcedDarkProvider } from '../../theme';
import { Screen } from '../../components/Screen';
import { Button, EmptyState } from '../../ui';

export default function CameraWeb() {
  const router = useRouter();
  return (
    <ForcedDarkProvider>
      <Screen center>
        <View style={{ gap: 16, alignItems: 'center' }}>
          <EmptyState
            icon="camera-outline"
            title="Camera is on the app"
            body="In-app capture (photo & video) runs on the twenty4 mobile app. Add from your library here, or open the app to capture."
          />
          <Button label="Back to Today" variant="secondary" onPress={() => router.back()} />
        </View>
      </Screen>
    </ForcedDarkProvider>
  );
}
