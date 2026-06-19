import type { ExpoConfig } from 'expo/config';

/**
 * twenty4 — Expo app config (SDK 56, New Architecture, expo-router).
 *
 * Native module config plugins (camera/image-picker/media-library/video/
 * notifications) are declared here so the dev client builds them, but no
 * native-only module is imported on any web-reachable path in Slice 0.
 */
const config: ExpoConfig = {
  name: 'twenty4',
  slug: 'twenty4',
  scheme: 'twenty4',
  version: '0.0.1',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  assetBundlePatterns: ['**/*'],
  ios: {
    bundleIdentifier: 'com.twenty4.app',
    supportsTablet: false,
    infoPlist: {
      // react-native-background-upload uses a background NSURLSession so a PUT can
      // finish after the app is backgrounded (the spec's true-background upload).
      UIBackgroundModes: ['fetch', 'processing'],
    },
  },
  android: {
    package: 'com.twenty4.app',
    // react-native-background-upload runs an Android foreground service for the
    // upload (required by Google's policy on Android 8+). The library autolinks;
    // these permissions let its service run + post the progress notification.
    permissions: [
      'INTERNET',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_DATA_SYNC',
      'POST_NOTIFICATIONS',
      'READ_MEDIA_IMAGES',
      'READ_MEDIA_VIDEO',
    ],
  },
  web: {
    bundler: 'metro',
    output: 'static',
  },
  plugins: [
    'expo-router',
    'expo-font',
    'expo-secure-store',
    [
      'expo-camera',
      {
        cameraPermission: 'twenty4 uses the camera to capture today’s moments.',
        microphonePermission: 'twenty4 uses the microphone to record video clips.',
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'twenty4 accesses your photos so you can add today’s media.',
      },
    ],
    [
      'expo-media-library',
      {
        photosPermission: 'twenty4 accesses your library to add and save today’s media.',
        savePhotosPermission: 'twenty4 saves your montage to your library.',
      },
    ],
    'expo-video',
    [
      'expo-notifications',
      {
        // Phase-1: local capture/expiry reminders only.
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
