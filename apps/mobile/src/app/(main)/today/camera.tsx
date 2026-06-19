/**
 * 2.2 Camera route — neutral fallback that re-exports the platform-split impl.
 *
 * The real screens live OUTSIDE src/app (in src/features) so expo-router's
 * require.context doesn't enumerate both the native + web variants into every
 * bundle. Metro resolves this single import to CameraScreen.web.tsx on web (a
 * device-only notice) and CameraScreen.tsx on iOS/Android (expo-camera +
 * background upload) — keeping the native modules off the web bundle entirely.
 */
export { default } from '../../../features/camera/CameraScreen';
