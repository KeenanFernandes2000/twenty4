/**
 * 2.2 Camera — in-app capture (DEVICE-ONLY).
 *
 * The primary capture surface (spec §9 missing-screen #1). expo-camera
 * CameraView with: photo/video capture, front/back switch, flash cycle, and a
 * record toggle. Captures are kind=`capture` (capturedInApp → trusted/auto-valid
 * §6) and flow straight into the background-upload pipeline (startUpload), then
 * we pop back to Today where the tray banner + grid pick them up.
 *
 * FORCED-DARK (ForcedDarkProvider) to match the prototype. This file imports
 * expo-camera at module scope, so it MUST stay native-only — camera.web.tsx is
 * the web stub Metro selects for `expo export -p web`.
 */
import { useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
  type CameraType,
  type FlashMode,
} from 'expo-camera';

import { ForcedDarkProvider, useTheme } from '../../theme';
import { Button, Icon } from '../../ui';
import { startUpload } from '../../lib/upload';
import { buildUploadMetadata, type RawAsset } from '../../lib/upload/metadata.native';

const FLASH_CYCLE: FlashMode[] = ['off', 'on', 'auto'];

function CameraScreenInner() {
  const theme = useTheme();
  const c = theme.colors;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraView>(null);

  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();

  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  // Permission gate.
  if (!camPerm) {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  if (!camPerm.granted) {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg, padding: 24, gap: 16, justifyContent: 'center' }]}>
        <Icon name="camera-outline" size={40} color={c.accent} />
        <Text style={{ ...theme.typography.heading, color: c.text }}>Camera access needed</Text>
        <Text style={{ ...theme.typography.body, color: c.muted }}>
          twenty4 uses the camera to capture today’s moments.
        </Text>
        <Button label="Grant access" onPress={() => void requestCamPerm()} />
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  const cycleFlash = () =>
    setFlash((f) => FLASH_CYCLE[(FLASH_CYCLE.indexOf(f) + 1) % FLASH_CYCLE.length]);
  const flipFacing = () => setFacing((f) => (f === 'back' ? 'front' : 'back'));
  const flashIcon = flash === 'off' ? 'flash-off' : flash === 'on' ? 'flash' : 'flash-outline';

  // Capture a photo → metadata → background upload → back to Today.
  const onPhoto = async () => {
    if (busy || recording) return;
    setBusy(true);
    try {
      const pic = await cameraRef.current?.takePictureAsync({ quality: 0.9, exif: true });
      if (pic?.uri) {
        await enqueue({
          uri: pic.uri,
          type: 'image',
          fileName: `capture-${Date.now()}.jpg`,
          mimeType: 'image/jpeg',
          width: pic.width,
          height: pic.height,
          exif: (pic.exif as Record<string, unknown> | undefined) ?? null,
        });
        router.back();
      }
    } finally {
      setBusy(false);
    }
  };

  // Toggle video recording. recordAsync resolves when stopRecording fires.
  const onToggleRecord = async () => {
    if (busy) return;
    if (recording) {
      cameraRef.current?.stopRecording();
      return;
    }
    if (!micPerm?.granted) {
      const res = await requestMicPerm();
      if (!res.granted) return;
    }
    setRecording(true);
    try {
      const result = await cameraRef.current?.recordAsync({ maxDuration: 60 });
      if (result?.uri) {
        await enqueue({
          uri: result.uri,
          type: 'video',
          fileName: `capture-${Date.now()}.mp4`,
          mimeType: 'video/mp4',
        });
        setRecording(false);
        router.back();
        return;
      }
    } finally {
      setRecording(false);
    }
  };

  // Resolve file size via background-upload's getFileInfo, then enqueue.
  const enqueue = async (asset: RawAsset) => {
    let sizeBytes = asset.fileSize;
    try {
      const Upload = (await import('react-native-background-upload')).default;
      const info = await Upload.getFileInfo(asset.uri.replace(/^file:\/\//, ''));
      if (info.size && info.size > 0) sizeBytes = info.size;
    } catch {
      // size unknown → metadata builder defaults to >=1 byte.
    }
    const meta = await buildUploadMetadata({ ...asset, fileSize: sizeBytes }, { capturedInApp: true });
    startUpload({
      localId: `cap-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      uri: asset.uri,
      label: asset.type === 'video' ? 'Camera video' : 'Camera photo',
      meta,
    });
  };

  return (
    <View style={[styles.fill, { backgroundColor: '#000' }]}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        mode={recording ? 'video' : 'picture'}
      />

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={styles.iconBtn}>
          <Icon name="close" size={24} color="#fff" />
        </Pressable>
        <Pressable onPress={cycleFlash} hitSlop={10} style={styles.iconBtn}>
          <Icon name={flashIcon} size={22} color="#fff" />
        </Pressable>
      </View>

      {/* Bottom controls */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 24 }]}>
        <View style={{ width: 56 }} />

        <Pressable
          accessibilityLabel={recording ? 'Stop recording' : 'Capture photo'}
          onPress={onPhoto}
          onLongPress={onToggleRecord}
          delayLongPress={250}
          disabled={busy}
          style={[styles.shutterOuter, { borderColor: recording ? c.danger : '#fff' }]}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View style={[styles.shutterInner, { backgroundColor: recording ? c.danger : '#fff' }]} />
          )}
        </Pressable>

        <Pressable onPress={flipFacing} hitSlop={10} style={styles.iconBtn}>
          <Icon name="camera-reverse-outline" size={26} color="#fff" />
        </Pressable>
      </View>

      <View style={[styles.hint, { bottom: insets.bottom + 110 }]}>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontFamily: theme.fontFamily.medium, fontSize: 12 }}>
          {recording ? 'Recording — tap to stop' : 'Tap for photo · hold for video'}
        </Text>
      </View>

      {Platform.OS === 'web' ? null : null}
    </View>
  );
}

export default function CameraScreen() {
  return (
    <ForcedDarkProvider>
      <CameraScreenInner />
    </ForcedDarkProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 58, height: 58, borderRadius: 29 },
  hint: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
});
