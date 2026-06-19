/**
 * MediaTile — one cell in the Today grid (2.1). Shows the presigned preview, a
 * type badge (photo/video + duration), a validation chip (pending/invalid), and
 * a long-press / button delete. Web-renderable (plain <Image>), Ember-themed.
 */
import { Image, Pressable, Text, View } from 'react-native';

import { useTheme } from '../theme';
import { Icon } from '../ui';
import type { MediaItemResponse } from '@twenty4/contracts/dto';

function durationLabel(ms?: number | null): string | null {
  if (!ms || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `0:${String(r).padStart(2, '0')}`;
}

export interface MediaTileProps {
  item: MediaItemResponse;
  onPress?: (item: MediaItemResponse) => void;
  onDelete?: (item: MediaItemResponse) => void;
}

export function MediaTile({ item, onPress, onDelete }: MediaTileProps) {
  const theme = useTheme();
  const c = theme.colors;
  const dur = durationLabel(item.durationMs);
  const isInvalid = item.validationStatus === 'invalid';
  const isPending = item.validationStatus === 'pending';

  return (
    <Pressable
      onPress={() => onPress?.(item)}
      onLongPress={() => onDelete?.(item)}
      style={{
        aspectRatio: 9 / 16,
        borderRadius: theme.radii.lg,
        overflow: 'hidden',
        backgroundColor: c.surface2,
        borderWidth: 1,
        borderColor: isInvalid ? c.danger : c.border,
      }}
    >
      {item.previewUrl ? (
        <Image
          source={{ uri: item.previewUrl }}
          style={{ width: '100%', height: '100%', opacity: isInvalid ? 0.45 : 1 }}
          resizeMode="cover"
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="image-outline" size={28} color={c.faint} />
        </View>
      )}

      {/* type / duration badge (top-left) */}
      <View
        style={{
          position: 'absolute',
          top: 6,
          left: 6,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 3,
          backgroundColor: 'rgba(0,0,0,0.55)',
          borderRadius: theme.radii.pill,
          paddingHorizontal: 7,
          paddingVertical: 3,
        }}
      >
        <Icon
          name={item.mediaType === 'video' ? 'videocam' : 'image'}
          size={11}
          color="#fff"
        />
        {dur ? (
          <Text style={{ color: '#fff', fontFamily: theme.fontFamily.mono, fontSize: 10 }}>
            {dur}
          </Text>
        ) : null}
      </View>

      {/* validation chip (bottom) */}
      {isPending || isInvalid ? (
        <View
          style={{
            position: 'absolute',
            bottom: 6,
            left: 6,
            right: 6,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            backgroundColor: isInvalid ? 'rgba(120,20,20,0.85)' : 'rgba(0,0,0,0.6)',
            borderRadius: theme.radii.sm,
            paddingHorizontal: 6,
            paddingVertical: 3,
          }}
        >
          <Icon
            name={isInvalid ? 'close-circle' : 'sync'}
            size={11}
            color="#fff"
          />
          <Text style={{ color: '#fff', fontFamily: theme.fontFamily.semibold, fontSize: 10 }}>
            {isInvalid ? 'Not from today' : 'Checking…'}
          </Text>
        </View>
      ) : null}

      {/* delete affordance (top-right) */}
      {onDelete ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete item"
          onPress={() => onDelete(item)}
          hitSlop={8}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 24,
            height: 24,
            borderRadius: 12,
            backgroundColor: 'rgba(0,0,0,0.55)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="trash-outline" size={13} color="#fff" />
        </Pressable>
      ) : null}
    </Pressable>
  );
}
