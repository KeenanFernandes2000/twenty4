/**
 * Ember design tokens — the ONLY place raw colors live in twenty4.
 *
 * Two frozen, typed token objects (`light`, `dark`) keyed to the Ember CSS
 * variables in `reference/Spool.html`. The `Theme` type is derived from `light`
 * so `useTheme()` is fully typed and every primitive is theme-driven.
 *
 * Provenance of each color:
 *   - FOUND in Spool.html: accent, onAccent, bg, canvas, surface, text, field,
 *     muted, danger, success, border, scrim, label, faint, hdsub, bezel, vid.
 *   - DERIVED (not present in Spool.html): vidBand — a translucent band sat over
 *     the `vid` gradient for the video letterbox/control bar. // TODO(design)
 *
 * `canvas` follows PLAN's value (light #e8dccd / dark #0a0a0c), which is the
 * app-shell backdrop behind cards; Spool's `--canvas` matches.
 */

/** Spacing scale (4pt base). */
export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
  '4xl': 64,
} as const;

/** Corner radii. */
export const radii = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  '2xl': 28,
  pill: 999,
  full: 9999,
} as const;

/** Font families — loaded by `useAppFonts()` (Nunito UI, JetBrains Mono mono). */
export const fontFamily = {
  regular: 'Nunito_400Regular',
  medium: 'Nunito_500Medium',
  semibold: 'Nunito_600SemiBold',
  bold: 'Nunito_700Bold',
  extrabold: 'Nunito_800ExtraBold',
  mono: 'JetBrainsMono_400Regular',
  monoBold: 'JetBrainsMono_700Bold',
} as const;

/** Type scale (size + sensible line height). */
export const typography = {
  display: { fontSize: 34, lineHeight: 40, fontFamily: fontFamily.extrabold },
  title: { fontSize: 26, lineHeight: 32, fontFamily: fontFamily.bold },
  heading: { fontSize: 20, lineHeight: 26, fontFamily: fontFamily.bold },
  subheading: { fontSize: 17, lineHeight: 23, fontFamily: fontFamily.semibold },
  body: { fontSize: 15, lineHeight: 22, fontFamily: fontFamily.regular },
  bodyStrong: { fontSize: 15, lineHeight: 22, fontFamily: fontFamily.semibold },
  caption: { fontSize: 13, lineHeight: 18, fontFamily: fontFamily.medium },
  label: { fontSize: 12, lineHeight: 16, fontFamily: fontFamily.semibold },
  mono: { fontSize: 14, lineHeight: 20, fontFamily: fontFamily.mono },
} as const;

/** Shadow/elevation presets (kept token-driven; color uses theme.scrim at call site). */
export const elevation = {
  none: 0,
  sm: 2,
  md: 6,
  lg: 12,
} as const;

/** The shape of a single theme's color palette. */
export interface ThemeColors {
  /** Brand accent. */
  accent: string;
  /** Secondary accent (warm). */
  accent2: string;
  /** Soft accent fill (translucent). */
  accentSoft: string;
  /** Text/icon color on top of `accent`. */
  onAccent: string;

  /** App background (root). */
  bg: string;
  /** Shell canvas behind cards. */
  canvas: string;
  /** Card / sheet surface. */
  surface: string;
  /** Slightly raised surface. */
  surface2: string;
  /** Highest surface. */
  surface3: string;

  /** Primary text. */
  text: string;
  /** Secondary text. */
  text2: string;
  /** Muted text. */
  muted: string;
  /** Faintest text / disabled. */
  faint: string;
  /** Field/section label. */
  label: string;
  /** Header subtitle. */
  hdsub: string;

  /** Input field fill. */
  field: string;
  /** Hairline border. */
  border: string;
  /** Bezel highlight (device-chrome look). */
  bezel: string;
  /** Modal/overlay scrim. */
  scrim: string;

  /** Semantic states. */
  danger: string;
  success: string;

  /** Video letterbox gradient stops (top → mid → bottom). */
  vid: readonly [string, string, string];
  /** Translucent band over video controls. */
  vidBand: string;
}

const light: ThemeColors = {
  accent: '#ec5430',
  accent2: '#e0930f',
  accentSoft: 'rgba(236,84,48,0.12)',
  onAccent: '#ffffff',

  bg: '#fbf6f1',
  canvas: '#e8dccd',
  surface: '#ffffff',
  surface2: '#f3ebe3',
  surface3: '#ece0d4',

  text: '#241712',
  text2: '#5f5147',
  muted: '#8a7a6d',
  faint: '#b3a496',
  label: '#9a8b7c',
  hdsub: '#6b5d52',

  field: '#f3ebe3',
  border: 'rgba(60,40,30,0.10)',
  bezel: 'rgba(0,0,0,0.14)',
  scrim: 'rgba(0,0,0,0.4)',

  danger: '#e23b3b',
  success: '#1fa572',

  vid: ['#5a4135', '#3a2820', '#241712'],
  vidBand: 'rgba(20,13,9,0.55)', // DERIVED // TODO(design)
};

const dark: ThemeColors = {
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
  bezel: 'rgba(255,255,255,0.06)',
  scrim: 'rgba(0,0,0,0.5)',

  danger: '#ff6a6a',
  success: '#36c98a',

  vid: ['#3c2b22', '#241914', '#140d09'],
  vidBand: 'rgba(0,0,0,0.55)', // DERIVED // TODO(design)
};

/** A complete theme: palette + shared scales. */
export interface Theme {
  scheme: 'light' | 'dark';
  colors: ThemeColors;
  spacing: typeof spacing;
  radii: typeof radii;
  fontFamily: typeof fontFamily;
  typography: typeof typography;
  elevation: typeof elevation;
}

export const lightTheme: Theme = Object.freeze({
  scheme: 'light',
  colors: Object.freeze(light),
  spacing,
  radii,
  fontFamily,
  typography,
  elevation,
});

export const darkTheme: Theme = Object.freeze({
  scheme: 'dark',
  colors: Object.freeze(dark),
  spacing,
  radii,
  fontFamily,
  typography,
  elevation,
});

export const themes = { light: lightTheme, dark: darkTheme } as const;
