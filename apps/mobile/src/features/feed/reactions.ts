/**
 * Reaction metadata — the five Ember reaction types (§5 / PLAN) mapped to an
 * emoji glyph + an Ionicons fallback + an a11y label. Shared by the feed card
 * reaction bar (3.1) and the player (3.2). Pure; no native imports.
 */
import type { ReactionType } from '@twenty4/contracts/enums';
import type { IconName } from '../../ui';

export interface ReactionMeta {
  type: ReactionType;
  /** Emoji glyph (matches the Spool prototype: 👍 😂 🔥 ❤️ 😮). */
  emoji: string;
  /** Ionicons fallback for tinting / filled-state affordance. */
  icon: IconName;
  label: string;
}

export const REACTIONS: ReactionMeta[] = [
  { type: 'like', emoji: '👍', icon: 'thumbs-up', label: 'Like' },
  { type: 'laugh', emoji: '😂', icon: 'happy', label: 'Haha' },
  { type: 'fire', emoji: '🔥', icon: 'flame', label: 'Fire' },
  { type: 'heart', emoji: '❤️', icon: 'heart', label: 'Love' },
  { type: 'shocked', emoji: '😮', icon: 'alert-circle', label: 'Wow' },
];

export const REACTION_BY_TYPE: Record<ReactionType, ReactionMeta> = Object.fromEntries(
  REACTIONS.map((r) => [r.type, r]),
) as Record<ReactionType, ReactionMeta>;
