/**
 * Small presentation helpers shared by the montage flow screens — theme card
 * gradients (2.6), music-id → label (2.5/2.7), and the "gone in Xh Ym" copy
 * (2.5/2.9). Pure; no native imports.
 */
import type { MontageOptionsResponse } from '@twenty4/contracts/dto';

/** Per-theme gradient stops for the 2.6 theme cards (matches the Spool prototype). */
export const THEME_GRADIENTS: Record<string, [string, string]> = {
  Chill: ['#2e4a6e', '#16243a'],
  Party: ['#7a2e6e', '#3a1640'],
  Clean: ['#4a4a52', '#222227'],
  Travel: ['#2e6e4a', '#163a26'],
  'Fast Cut': ['#6e5a2e', '#3a2e16'],
  Soft: ['#5a4a6e', '#2c2440'],
  Mellow: ['#6e2e3a', '#3a1620'],
  Random: ['#5a4135', '#241712'],
};

export function themeGradient(theme: string): [string, string] {
  return THEME_GRADIENTS[theme] ?? THEME_GRADIENTS.Random;
}

/** Resolve a music id to its display label using the loaded options (or the id). */
export function musicLabel(musicId: string | null | undefined, options?: MontageOptionsResponse): string {
  if (!musicId) return 'No music';
  const found = options?.music.find((m) => m.id === musicId);
  return found?.label ?? musicId;
}

/** "23h 59m" remaining until `iso` (or null when past/absent). */
export function timeRemaining(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}
