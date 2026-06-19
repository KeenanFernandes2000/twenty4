/**
 * ReactionBar — the five-reaction strip on a feed card (3.1) and the player
 * (3.2). Each pill shows the reaction glyph + the live count; the caller's
 * active reaction is highlighted (accent fill). Tapping fires the optimistic
 * mutate/rollback via the parent's `onToggle` (one reaction per user; tapping
 * the active one removes it). Web-safe; pure presentation + the toggle callback.
 *
 * The Spool prototype uses color emoji (👍😂🔥❤️😮). On device those render with
 * the native emoji font; we ALSO carry a tinted Ionicons glyph per type so the
 * affordance is unambiguous on platforms without a color-emoji font (the web
 * export screenshots). Both come from `./reactions`.
 */
import { Pressable, Text, View } from 'react-native';

import { useTheme } from '../../theme';
import { Icon } from '../../ui';
import type { ReactionSummary } from '@twenty4/contracts/dto';
import type { ReactionType } from '@twenty4/contracts/enums';
import { REACTIONS } from './reactions';

export interface ReactionBarProps {
  summary: ReactionSummary;
  onToggle: (type: ReactionType, current: ReactionType | null) => void;
  /** Dark surfaces (the player) flip the unselected pill tones. */
  dark?: boolean;
  disabled?: boolean;
}

export function ReactionBar({ summary, onToggle, dark = false, disabled = false }: ReactionBarProps) {
  const theme = useTheme();
  const c = theme.colors;
  const mine = summary.mine ?? null;

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {REACTIONS.map((r) => {
        const count = summary.counts?.[r.type] ?? 0;
        const selected = mine === r.type;
        const bg = selected
          ? c.accent
          : dark
            ? 'rgba(255,255,255,0.10)'
            : c.surface2;
        const fg = selected ? c.onAccent : dark ? '#f7f0e9' : c.text;
        const border = selected ? c.accent : dark ? 'rgba(255,255,255,0.14)' : c.border;
        return (
          <Pressable
            key={r.type}
            accessibilityRole="button"
            accessibilityLabel={`${r.label}${count ? `, ${count}` : ''}`}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onToggle(r.type, mine)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              paddingVertical: 7,
              paddingHorizontal: 11,
              borderRadius: theme.radii.pill,
              borderWidth: 1,
              borderColor: border,
              backgroundColor: bg,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Icon name={r.icon} size={16} color={selected ? c.onAccent : c.accent} />
            {count > 0 ? (
              <Text style={{ color: fg, fontFamily: theme.fontFamily.bold, fontSize: 13 }}>{count}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
