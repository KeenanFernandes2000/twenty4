// Ember design tokens (dark) ported from apps/mobile/src/theme/tokens.ts.
// The admin console is utilitarian, so it runs a single dark theme. These are the
// canonical Ember dark palette values — the ONLY place raw colors live here.

export const c = {
  accent: '#ff7a52',
  accent2: '#ffb347',
  accentSoft: 'rgba(255,122,82,0.16)',
  onAccent: '#ffffff',

  bg: '#161210',
  canvas: '#0a0a0c',
  surface: '#221c18',
  surface2: '#2c241f',
  surface3: '#382e27',

  text: '#f7f0e9',
  text2: '#cdbfb3',
  muted: '#a3958a',
  faint: '#6e635a',
  label: '#7a7a82',
  hdsub: '#9a9aa2',

  field: '#2c241f',
  border: 'rgba(255,240,230,0.09)',
  scrim: 'rgba(0,0,0,0.6)',

  danger: '#ff6a6a',
  success: '#36c98a',
  warn: '#ffb347',
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
} as const;

export const font = {
  ui: "'Nunito', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
} as const;

/** Status -> color, for account_status / report_status pills. */
export function statusColor(status: string): string {
  switch (status) {
    case 'active':
    case 'actioned':
      return c.success;
    case 'suspended':
    case 'under_review':
      return c.warn;
    case 'banned':
    case 'deleted':
      return c.danger;
    case 'open':
      return c.accent;
    case 'dismissed':
      return c.muted;
    default:
      return c.muted;
  }
}
