/**
 * 2.3 Gallery pick — add today's library media (DEVICE-ONLY).
 *
 * expo-image-picker (multi-select photos + videos, EXIF on) → for each picked
 * asset we read EXIF / media-library creationTime (the §6 validation hierarchy
 * source for capture time) via buildUploadMetadata, then push it into the
 * background-upload pipeline (startUpload). On return, Today's tray banner + grid
 * surface them. Picked items are kind=`pick` (capturedInApp=false) → the server
 * validates them against the resolved capture time vs the 4am bucket.
 *
 * Imports expo-image-picker at module scope → native-only. gallery.web.tsx is the
 * web stub Metro selects for the web export.
 */
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';

import { useTheme } from '../../theme';
import { Screen } from '../../components/Screen';
import { Button, EmptyState, Icon } from '../../ui';
import { startUpload } from '../../lib/upload';
import { buildUploadMetadata, type RawAsset } from '../../lib/upload/metadata.native';

export default function GalleryPick() {
  const theme = useTheme();
  const c = theme.colors;
  const router = useRouter();

  const [status, setStatus] = useState<'idle' | 'picking' | 'processing' | 'denied'>('idle');
  const [count, setCount] = useState(0);
  const launched = useRef(false);

  const pick = async () => {
    setStatus('picking');
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setStatus('denied');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: 20,
      exif: true,
      quality: 0.9,
      videoMaxDuration: 60,
    });

    if (result.canceled || result.assets.length === 0) {
      router.back();
      return;
    }

    setStatus('processing');
    setCount(result.assets.length);

    for (const asset of result.assets) {
      const raw: RawAsset = {
        uri: asset.uri,
        type: asset.type ?? (asset.duration ? 'video' : 'image'),
        fileName: asset.fileName,
        fileSize: asset.fileSize,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        duration: asset.duration,
        exif: (asset.exif as Record<string, unknown> | null) ?? null,
        assetId: asset.assetId,
      };
      const meta = await buildUploadMetadata(raw, { capturedInApp: false });
      startUpload({
        localId: `pick-${asset.assetId ?? Date.now()}-${Math.round(Math.random() * 1e6)}`,
        uri: asset.uri,
        label: asset.fileName ?? (raw.type === 'video' ? 'Library video' : 'Library photo'),
        meta,
      });
    }

    // Hand off to Today (tray banner + grid show progress).
    router.back();
  };

  // Auto-launch the picker once on mount (the screen IS the picker).
  useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    void pick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'denied') {
    return (
      <Screen center>
        <View style={{ gap: 16, alignItems: 'center' }}>
          <EmptyState
            icon="lock-closed-outline"
            title="Library access needed"
            body="twenty4 needs permission to read today’s photos and videos so you can add them."
          />
          <Button label="Try again" onPress={() => void pick()} />
          <Button label="Back" variant="ghost" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen center>
      <View style={{ alignItems: 'center', gap: 14 }}>
        <ActivityIndicator color={c.accent} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="images-outline" size={18} color={c.muted} />
          <Text style={{ ...theme.typography.body, color: c.muted }}>
            {status === 'processing'
              ? `Adding ${count} item${count > 1 ? 's' : ''}…`
              : 'Opening your library…'}
          </Text>
        </View>
      </View>
    </Screen>
  );
}
