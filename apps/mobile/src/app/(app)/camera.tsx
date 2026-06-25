// (app)/camera — the capture screen (§9.1). Full-bleed CameraView preview when the
// camera is available + permitted; a styled "unavailable / grant permission" state
// otherwise (this is what web / headless Chromium shows — it must NEVER white-screen
// or throw). Each capture builds an UploadAsset and immediately enqueues it (uploads
// run in the background) AND pushes it onto a local session thumb strip.
//
// expo-camera 56.0.8 API used (verified against the installed .d.ts):
//   • <CameraView ref facing flash mode style onCameraReady onMountError /> — facing
//     'front'|'back', flash 'off'|'on'|'auto', mode 'picture'|'video'. style via ViewProps.
//   • ref is a CameraView CLASS instance → ref.takePictureAsync(opts?) :Promise<CameraCapturedPicture>
//     ({ uri,width,height,format }); ref.recordAsync(opts?) :Promise<{uri}|undefined>
//     (resolves when stopped); ref.stopRecording() :void (synchronous).
//   • useCameraPermissions()/useMicrophonePermissions() → [permission|null, request, _get];
//     permission has { granted, status, canAskAgain }.
//
// expo-camera is imported ONLY here (and never in shared web-rendered components).
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
  type CameraType,
  type FlashMode,
  type CameraMode,
} from 'expo-camera';
import { Button, Screen, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { useUploadStore, type UploadAsset } from '@/stores/uploadStore';
import { CaptureThumbStrip } from '@/components/media/CaptureThumbStrip';

const FLASH_NEXT: Record<'off' | 'on' | 'auto', FlashMode> = {
  off: 'on',
  on: 'auto',
  auto: 'off',
};
const FLASH_LABEL: Record<string, string> = { off: 'Flash off', on: 'Flash on', auto: 'Flash auto' };

// Video can only be recorded on native (recordAsync is a no-op in headless/web), so
// the Video mode toggle is hidden on web — never offer a record action that can't work.
const VIDEO_SUPPORTED = Platform.OS !== 'web';

// Derive a video content-type from the produced file's extension so /complete's
// HeadObject content-type matches the actual container (a hardcoded video/mp4 415s
// when the camera produces a .mov). iOS records .mov; Android records .mp4.
function videoContentTypeFor(uri: string): string {
  return /\.mov(\?|$)/i.test(uri) ? 'video/quicktime' : 'video/mp4';
}

// Derive a photo content-type from the produced file's extension/format. takePictureAsync
// defaults to JPEG on Android, but map .png/.heic when the uri says so; default image/jpeg.
function photoContentTypeFor(uri: string): string {
  if (/\.png(\?|$)/i.test(uri)) return 'image/png';
  if (/\.heic(\?|$)/i.test(uri)) return 'image/heic';
  if (/\.heif(\?|$)/i.test(uri)) return 'image/heif';
  return 'image/jpeg';
}

export default function CameraScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();

  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [mode, setMode] = useState<CameraMode>('picture');
  const [ready, setReady] = useState(false); // onCameraReady fired
  const [mountFailed, setMountFailed] = useState(false); // onMountError (e.g. no real camera on web)
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);

  // Just-captured assets for this session (the thumb strip + the "view today" count).
  const [captured, setCaptured] = useState<UploadAsset[]>([]);

  // Ask for camera permission on mount (web grants/denies via getUserMedia).
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.granted]);

  // Recording elapsed timer.
  useEffect(() => {
    if (!recording) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const enqueueAndStrip = (asset: UploadAsset) => {
    setCaptured((prev) => [asset, ...prev]);
    useUploadStore.getState().enqueue([asset]);
  };

  const onCapturePhoto = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      const pic = await cameraRef.current.takePictureAsync({ quality: 1 });
      if (!pic?.uri) throw new Error('no-uri');
      const now = new Date().toISOString();
      enqueueAndStrip({
        uri: pic.uri,
        mediaType: 'photo',
        contentType: photoContentTypeFor(pic.uri),
        width: pic.width,
        height: pic.height,
        // Captures are genuinely now: set BOTH the device-library tier and the
        // declared tier so the worker can validate as today via either path.
        deviceCapturedAt: now,
        declaredOriginalTimestamp: now,
      });
      toast.show({ type: 'success', message: 'Captured — uploading…' });
    } catch {
      toast.show({ type: 'error', message: 'Could not take the photo.' });
    } finally {
      setBusy(false);
    }
  };

  const onStartRecording = async () => {
    if (!cameraRef.current || busy) return;
    // Video needs the mic too; request it lazily on first record. Also request when
    // the permission object is still null (hook hasn't resolved yet) — don't skip the
    // request just because we haven't heard back.
    if (!micPermission?.granted) {
      const res = await requestMicPermission();
      if (!res.granted) {
        toast.show({ type: 'error', message: 'Microphone is needed to record video.' });
        return;
      }
    }
    setBusy(true);
    setRecording(true);
    const capturedAt = new Date().toISOString();
    try {
      // recordAsync resolves when stopRecording() is called (or limits hit).
      const result = await cameraRef.current.recordAsync();
      if (result?.uri) {
        enqueueAndStrip({
          uri: result.uri,
          mediaType: 'video',
          // Derive the content-type from the produced container (.mov→quicktime,
          // else mp4) so /complete doesn't 415 on a non-mp4 capture.
          contentType: videoContentTypeFor(result.uri),
          deviceCapturedAt: capturedAt,
          declaredOriginalTimestamp: capturedAt,
        });
        toast.show({ type: 'success', message: 'Recorded — uploading…' });
      }
    } catch {
      toast.show({ type: 'error', message: 'Could not record the video.' });
    } finally {
      setRecording(false);
      setBusy(false);
    }
  };

  const onStopRecording = () => {
    if (!cameraRef.current) return;
    cameraRef.current.stopRecording(); // synchronous; resolves the recordAsync promise
  };

  const onShutter = () => {
    if (mode === 'picture') {
      void onCapturePhoto();
    } else if (recording) {
      onStopRecording();
    } else {
      void onStartRecording();
    }
  };

  const cycleFlash = () =>
    setFlash((f) => FLASH_NEXT[(f as 'off' | 'on' | 'auto')] ?? 'off');
  const flipFacing = () => setFacing((f) => (f === 'back' ? 'front' : 'back'));
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(app)/today');
  };
  const goToday = () => router.replace('/(app)/today');

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  // ── Permission / unavailable state (web + denied paths land here) ────────────
  // permission === null → hook still loading; render a neutral frame, not a crash.
  const denied = permission != null && !permission.granted;
  const unavailable = mountFailed; // camera mounted but the stream isn't usable (e.g. headless web)

  if (denied || unavailable) {
    return (
      <Screen>
        <View
          testID="camera-screen"
          style={{ flex: 1, justifyContent: 'center', gap: theme.spacing.lg }}
        >
          <Text variant="h2" align="center">
            Camera unavailable
          </Text>
          <Text variant="body" color="muted" align="center">
            {denied
              ? 'Grant camera access to capture photos and video. You can also Import from your library on the Today screen.'
              : 'No camera is available on this device. Use Import on the Today screen instead.'}
          </Text>
          {denied ? (
            <Button
              variant="primary"
              fullWidth
              title="Grant camera access"
              onPress={() => void requestPermission()}
              testID="camera-grant"
            />
          ) : null}
          <Button
            variant="secondary"
            fullWidth
            title="Back to Today"
            onPress={goToday}
            testID="camera-close"
          />
        </View>
      </Screen>
    );
  }

  // permission still resolving → minimal frame (no camera mount yet).
  if (!permission) {
    return (
      <Screen>
        <View testID="camera-screen" style={{ flex: 1, justifyContent: 'center' }}>
          <Text variant="body" color="muted" align="center">
            Preparing camera…
          </Text>
        </View>
      </Screen>
    );
  }

  // ── Live camera ─────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.canvas }} testID="camera-screen">
      <CameraView
        ref={cameraRef}
        style={{ flex: 1 }}
        facing={facing}
        flash={flash}
        mode={mode}
        onCameraReady={() => setReady(true)}
        onMountError={() => setMountFailed(true)}
      />

      {/* Top bar: close + flash + flip + (recording indicator) */}
      <View
        style={{
          position: 'absolute',
          top: theme.spacing.huge,
          left: theme.spacing.xl,
          right: theme.spacing.xl,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.base,
        }}
      >
        <Button variant="ghost" size="sm" title="Done" onPress={close} testID="camera-close" />
        <View style={{ flex: 1, alignItems: 'center' }}>
          {recording ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: theme.radii.full,
                  backgroundColor: theme.colors.danger,
                }}
              />
              <Text variant="label" color="onAccent">
                {mm}:{ss}
              </Text>
            </View>
          ) : null}
        </View>
        <Button
          variant="ghost"
          size="sm"
          title={FLASH_LABEL[flash] ?? 'Flash'}
          onPress={cycleFlash}
          testID="camera-flash"
        />
        <Button
          variant="ghost"
          size="sm"
          title="Flip"
          onPress={flipFacing}
          testID="camera-flip"
        />
      </View>

      {/* Bottom controls: thumb strip + mode toggle + shutter + view-today */}
      <View
        style={{
          position: 'absolute',
          bottom: theme.spacing.huge,
          left: theme.spacing.xl,
          right: theme.spacing.xl,
          gap: theme.spacing.lg,
        }}
      >
        <CaptureThumbStrip assets={captured} />

        {/* Photo / Video mode toggle — Video is hidden on web (recording can't work
            headless), so the web build is Photo-only. */}
        {VIDEO_SUPPORTED ? (
          <View
            style={{
              flexDirection: 'row',
              alignSelf: 'center',
              backgroundColor: theme.colors.scrim,
              borderRadius: theme.radii.pill,
              padding: theme.spacing.xxs,
            }}
            testID="camera-mode-toggle"
          >
            {(['picture', 'video'] as CameraMode[]).map((m) => {
              const active = mode === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => !recording && setMode(m)}
                  accessibilityRole="button"
                  testID={`camera-mode-${m === 'picture' ? 'photo' : 'video'}`}
                  style={{
                    paddingHorizontal: theme.spacing.lg,
                    paddingVertical: theme.spacing.sm,
                    borderRadius: theme.radii.pill,
                    backgroundColor: active ? theme.colors.accentSoft : 'transparent',
                  }}
                >
                  <Text variant="label" color={active ? 'accent' : 'secondary'}>
                    {m === 'picture' ? 'Photo' : 'Video'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* Shutter */}
        <View style={{ alignItems: 'center' }}>
          <Pressable
            onPress={onShutter}
            // Disable while busy in ALL modes so a double-tap can't double-trigger a
            // capture/start. EXCEPTION: while actively recording the shutter must stay
            // live so the same button can STOP the recording (onShutter → stop).
            disabled={busy && !recording}
            accessibilityRole="button"
            accessibilityLabel={mode === 'picture' ? 'Take photo' : recording ? 'Stop' : 'Record'}
            testID="shutter-button"
            style={({ pressed }) => [
              {
                width: 76,
                height: 76,
                borderRadius: theme.radii.full,
                borderWidth: 4,
                borderColor: theme.colors.textPrimary,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <View
              style={{
                width: recording ? 30 : 60,
                height: recording ? 30 : 60,
                borderRadius: recording ? theme.radii.sm : theme.radii.full,
                backgroundColor: mode === 'video' ? theme.colors.danger : theme.colors.textPrimary,
              }}
            />
          </Pressable>
        </View>

        {/* View today (N uploading) */}
        {captured.length > 0 ? (
          <Button
            variant="secondary"
            fullWidth
            title={`View today (${captured.length} uploading)`}
            onPress={goToday}
            testID="camera-view-today"
          />
        ) : null}
      </View>

      {/* While the preview hasn't reported ready on native, a faint hint (web reports
          ready quickly; if it never mounts, onMountError → unavailable state above). */}
      {!ready && Platform.OS !== 'web' ? (
        <View
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            alignItems: 'center',
          }}
        >
          <Text variant="caption" color="muted">
            Starting camera…
          </Text>
        </View>
      ) : null}
    </View>
  );
}
