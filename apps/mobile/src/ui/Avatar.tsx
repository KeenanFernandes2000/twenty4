import { useState } from 'react';
import { Image, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { Text } from './Text';

export type AvatarSize = 'sm' | 'md' | 'lg';

export interface AvatarProps {
  size?: AvatarSize;
  /** Image source URI; falls back to initials if absent or it fails to load. */
  uri?: string;
  /** Name used to derive initials for the fallback. */
  name?: string;
  style?: StyleProp<ViewStyle>;
}

const SIZE_PX: Record<AvatarSize, number> = { sm: 32, md: 44, lg: 64 };

function initialsOf(name?: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

export function Avatar({ size = 'md', uri, name, style }: AvatarProps) {
  const theme = useTheme();
  const dim = SIZE_PX[size];
  const [failed, setFailed] = useState(false);

  const containerStyle: ViewStyle = {
    width: dim,
    height: dim,
    borderRadius: theme.radii.full,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accentSoft,
  };

  const showImage = uri != null && uri.length > 0 && !failed;

  return (
    <View style={[containerStyle, style]}>
      {showImage ? (
        <Image
          source={{ uri }}
          onError={() => setFailed(true)}
          style={{ width: dim, height: dim }}
          accessibilityRole="image"
          accessibilityLabel={name}
        />
      ) : (
        <Text
          variant={size === 'lg' ? 'title' : size === 'md' ? 'bodyLg' : 'label'}
          weight="black"
          color="accent"
        >
          {initialsOf(name)}
        </Text>
      )}
    </View>
  );
}
