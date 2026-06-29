// ReactionBar — the 5-emoji reaction row on a feed card / player. One replaceable
// reaction per user (M8 §11): tap an emoji to set/replace it, tap the active one
// again to clear. The active pick is highlighted (ember pill). The mutation
// (useReact) does the optimistic count + viewerReaction patch; this is pure UI.
import { Pressable, View } from 'react-native';
import type { ReactionType } from '@twenty4/contracts';
import { Text } from '@/ui';
import { useTheme } from '@/theme';

// Order + glyphs locked to the spec set: like / laugh / fire / heart / shocked.
export const REACTIONS: readonly { type: ReactionType; emoji: string }[] = [
  { type: 'like', emoji: '👍' },
  { type: 'laugh', emoji: '😂' },
  { type: 'fire', emoji: '🔥' },
  { type: 'heart', emoji: '❤️' },
  { type: 'shocked', emoji: '😮' },
] as const;

export function ReactionBar({
  viewerReaction,
  onReact,
  disabled = false,
  testIDPrefix = 'reaction',
}: {
  viewerReaction: ReactionType | null;
  /** Called with the tapped type; the caller decides set/replace vs clear. */
  onReact: (type: ReactionType) => void;
  disabled?: boolean;
  testIDPrefix?: string;
}) {
  const theme = useTheme();

  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.sm }} accessibilityRole="radiogroup">
      {REACTIONS.map(({ type, emoji }) => {
        const selected = viewerReaction === type;
        return (
          <Pressable
            key={type}
            onPress={() => onReact(type)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={`React ${type}`}
            testID={`${testIDPrefix}-${type}`}
            hitSlop={6}
            style={({ pressed }) => ({
              width: 40,
              height: 40,
              borderRadius: theme.radii.full,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              backgroundColor: selected ? theme.colors.accentSoft : theme.colors.surface2,
              opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
            })}
          >
            <Text variant="body">{emoji}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
