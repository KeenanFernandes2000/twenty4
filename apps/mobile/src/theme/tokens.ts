import { Platform } from 'react-native';
import type { ViewStyle } from 'react-native';

/**
 * Ember design tokens — single warm dark theme.
 *
 * This is the source of truth for color/spacing/radius/type/elevation. Every
 * `ui/*` primitive consumes these (via `useTheme()`), never hard-coded values.
 *
 * RN note: custom fonts ignore numeric `fontWeight`, so "weight" is expressed by
 * picking the right loaded `fontFamily` (see `fonts` + `type` below).
 */

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export const colors = {
  // surfaces (warm dark, stepped elevation)
  canvas: '#0a0a0c',
  bg: '#161210',
  surface: '#221c18',
  surface2: '#2c241f',
  field: '#2c241f', // alias of surface2 — input/field background
  surface3: '#382e27',

  // lines / overlays
  border: 'rgba(255,240,230,0.09)',
  bezel: 'rgba(255,255,255,0.06)',
  scrim: 'rgba(0,0,0,0.5)',

  // brand ember accent (the one glow)
  accent: '#ff7a52',
  accent2: '#ffb347',
  accentSoft: 'rgba(255,122,82,0.16)',
  onAccent: '#ffffff',

  // text ramp
  textPrimary: '#f7f0e9',
  textSecondary: '#cdbfb3',
  textMuted: '#a3958a',
  textLabel: '#7a7a82',
  textFaint: '#6e635a',

  // status
  success: '#36c98a',
  danger: '#ff6a6a',
} as const;

/**
 * Ember primary-CTA gradient (~140°): top-left → bottom-right.
 * Typed as a 2-tuple so `expo-linear-gradient` accepts it directly.
 */
export const accentGradient: readonly [string, string] = ['#ffb86c', '#ff5236'];
export const accentGradientStart = { x: 0, y: 0 } as const;
export const accentGradientEnd = { x: 1, y: 1 } as const;

// ---------------------------------------------------------------------------
// Spacing (base unit 4; heavy 6/12/14 usage)
// ---------------------------------------------------------------------------

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  base: 12,
  lg: 14,
  xl: 16,
  xxl: 24,
  huge: 32,
  section: 64,
} as const;

// ---------------------------------------------------------------------------
// Radii
// ---------------------------------------------------------------------------

export const radii = {
  xs: 3,
  sm: 8,
  md: 12,
  lg: 14,
  xl: 18,
  xxl: 20,
  xxxl: 28,
  pill: 999,
  full: 9999,
} as const;

// ---------------------------------------------------------------------------
// Fonts — family map. "weight" == fontFamily (custom fonts ignore fontWeight).
// ---------------------------------------------------------------------------

export const fonts = {
  regular: 'Nunito_400Regular',
  semibold: 'Nunito_600SemiBold',
  bold: 'Nunito_700Bold',
  extrabold: 'Nunito_800ExtraBold',
  black: 'Nunito_900Black',
  mono: 'JetBrainsMono_400Regular',
  monoBold: 'JetBrainsMono_700Bold',
} as const;

export type FontWeightName = keyof typeof fonts;

// ---------------------------------------------------------------------------
// Type scale. letterSpacing in px (em * fontSize). lineHeight absolute px.
// headings ~1.15, body ~1.5.
// ---------------------------------------------------------------------------

export interface TypeStyle {
  fontSize: number;
  fontFamily: string;
  letterSpacing: number;
  lineHeight: number;
}

export const type = {
  display: {
    fontSize: 34,
    fontFamily: fonts.black,
    letterSpacing: 34 * -0.02, // -0.68
    lineHeight: Math.round(34 * 1.15),
  },
  h1: {
    fontSize: 30,
    fontFamily: fonts.black,
    letterSpacing: 30 * -0.02, // -0.6
    lineHeight: Math.round(30 * 1.15),
  },
  h2: {
    fontSize: 24,
    fontFamily: fonts.extrabold,
    letterSpacing: 24 * -0.02, // -0.48
    lineHeight: Math.round(24 * 1.15),
  },
  title: {
    fontSize: 22,
    fontFamily: fonts.extrabold,
    letterSpacing: 22 * -0.01, // -0.22
    lineHeight: Math.round(22 * 1.15),
  },
  bodyLg: {
    fontSize: 18,
    fontFamily: fonts.bold,
    letterSpacing: 0,
    lineHeight: Math.round(18 * 1.5),
  },
  body: {
    fontSize: 15,
    fontFamily: fonts.bold,
    letterSpacing: 0,
    lineHeight: Math.round(15 * 1.5),
  },
  label: {
    fontSize: 13,
    fontFamily: fonts.extrabold,
    letterSpacing: 13 * 0.02, // +0.26
    lineHeight: Math.round(13 * 1.3),
  },
  caption: {
    fontSize: 12,
    fontFamily: fonts.bold,
    letterSpacing: 0,
    lineHeight: Math.round(12 * 1.4),
  },
  micro: {
    fontSize: 11,
    fontFamily: fonts.extrabold,
    letterSpacing: 11 * 0.06, // +0.66 (uppercase overline)
    lineHeight: Math.round(11 * 1.3),
  },
} as const satisfies Record<string, TypeStyle>;

export type TypeVariant = keyof typeof type;

// ---------------------------------------------------------------------------
// Shadows / elevation — per-platform.
// iOS: shadowColor/Offset/Opacity/Radius. Android: elevation (no tint).
// Web (react-native-web): boxShadow string.
// ---------------------------------------------------------------------------

type ShadowDef = {
  /** web boxShadow string */
  web: string;
  /** iOS shadow params */
  ios: {
    shadowColor: string;
    shadowOffset: { width: number; height: number };
    shadowOpacity: number;
    shadowRadius: number;
  };
  /** android elevation (tint not supported) */
  android: number;
};

const shadowDefs = {
  // neutral card: 0 10px 30px -10px rgba(0,0,0,.6)
  card: {
    web: '0px 10px 30px -10px rgba(0,0,0,0.6)',
    ios: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.6,
      shadowRadius: 15,
    },
    android: 6,
  },
  // modal: 0 14px 40px -8px rgba(0,0,0,.7)
  modal: {
    web: '0px 14px 40px -8px rgba(0,0,0,0.7)',
    ios: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 14 },
      shadowOpacity: 0.7,
      shadowRadius: 20,
    },
    android: 12,
  },
  // ember glow (primary CTA): 0 12px 28px -10px rgba(255,82,54,.6)
  glow: {
    web: '0px 12px 28px -10px rgba(255,82,54,0.6)',
    ios: {
      shadowColor: '#ff5236',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.6,
      shadowRadius: 14,
    },
    android: 8,
  },
  // no shadow
  none: {
    web: 'none',
    ios: {
      shadowColor: 'transparent',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0,
      shadowRadius: 0,
    },
    android: 0,
  },
} as const satisfies Record<string, ShadowDef>;

export type ShadowName = keyof typeof shadowDefs;

/**
 * Resolve a named elevation to the correct per-platform style object.
 * Spread into a `style`: `style={[base, shadow('glow')]}`.
 */
export function shadow(name: ShadowName): ViewStyle {
  const def = shadowDefs[name];
  return Platform.select<ViewStyle>({
    web: { boxShadow: def.web } as ViewStyle,
    android: { elevation: def.android },
    default: def.ios,
  }) as ViewStyle;
}

export const shadows = shadowDefs;

// ---------------------------------------------------------------------------
// Assembled theme object (flows through context).
// ---------------------------------------------------------------------------

export const theme = {
  colors,
  spacing,
  radii,
  fonts,
  type,
  accentGradient,
  accentGradientStart,
  accentGradientEnd,
  shadows,
  shadow,
} as const;

export type Theme = typeof theme;

// Re-exported helper type used by `Text` color prop.
export type ColorName = keyof typeof colors;

// Convenience: a style fragment for the ember CTA glow (used by Button).
export const emberGlow: ViewStyle = shadow('glow');
