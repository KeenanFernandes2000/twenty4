/**
 * 2.3 Gallery route — neutral fallback that re-exports the platform-split impl.
 *
 * Real screens live in src/features (outside require.context) so the native
 * picker variant isn't pulled into the web bundle. Metro resolves this to
 * GalleryScreen.web.tsx on web (device-only notice) and GalleryScreen.tsx on
 * iOS/Android (expo-image-picker + media-library EXIF metadata).
 */
export { default } from '../../../features/gallery/GalleryScreen';
