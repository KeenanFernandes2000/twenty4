/**
 * Avatar — circular initials/image avatar, Ember-themed.
 */
import { Image, Text, View } from 'react-native';
import { useTheme } from '../theme';

export interface AvatarProps {
  name?: string;
  uri?: string;
  size?: number;
}

function initials(name?: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export function Avatar({ name, uri, size = 40 }: AvatarProps) {
  const theme = useTheme();
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityLabel={name ? `${name} avatar` : 'avatar'}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.colors.accentSoft,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: theme.colors.accent,
          fontFamily: theme.fontFamily.bold,
          fontSize: size * 0.4,
        }}
      >
        {initials(name)}
      </Text>
    </View>
  );
}
