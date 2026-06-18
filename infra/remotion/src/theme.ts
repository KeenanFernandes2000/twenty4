/**
 * Per-theme visual configuration the renderer applies (§7.1 step 4).
 *
 * The EDL's `themeStyle.theme` (a `ConcreteTheme`) selects one of these. Each
 * entry maps a theme to a CSS color-grade (filter string) + an overlay treatment
 * + default transition preference. The intelligence already encodes the
 * structural choices (cut density, transition per segment) in the EDL; this file
 * is the *visual* dressing the renderer owns.
 *
 * Ember accent palette (PLAN.md): accent #ec5430 / #ff7a52, on-accent #fff.
 */
import type { ConcreteTheme } from '@twenty4/contracts/enums';
import type { OverlayType, TransitionType } from '@twenty4/contracts/edl';

export interface ThemeVisual {
  /** CSS `filter` applied to every segment's media (the "color grade" / LUT). */
  colorGrade: string;
  /** Optional CSS `background` painted UNDER the media (shows during letterbox). */
  background: string;
  /** Default overlay treatment for the theme (EDL may override per-segment). */
  defaultOverlay: OverlayType;
  /** Default overlay intensity 0..1. */
  overlayIntensity: number;
  /** Theme's preferred transition (EDL may override per-segment). */
  defaultTransition: TransitionType;
  /** Accent color used by chrome overlays (caption chip / date stamp). */
  accent: string;
  /** A subtle tint overlaid on top of media (rgba) for mood; '' = none. */
  tint: string;
}

const ACCENT = '#ec5430';
const ACCENT_LIGHT = '#ff7a52';

export const THEME_VISUALS: Record<ConcreteTheme, ThemeVisual> = {
  Chill: {
    colorGrade: 'saturate(1.05) brightness(1.02) contrast(0.98)',
    background: '#161210',
    defaultOverlay: 'light_leak',
    overlayIntensity: 0.25,
    defaultTransition: 'crossfade',
    accent: ACCENT_LIGHT,
    tint: 'rgba(255,160,90,0.06)',
  },
  Party: {
    colorGrade: 'saturate(1.35) contrast(1.12) brightness(1.04)',
    background: '#0a0a0c',
    defaultOverlay: 'flash',
    overlayIntensity: 0.5,
    defaultTransition: 'cut',
    accent: ACCENT,
    tint: 'rgba(236,84,48,0.05)',
  },
  Clean: {
    colorGrade: 'saturate(1.0) contrast(1.04) brightness(1.03)',
    background: '#fbf6f1',
    defaultOverlay: 'none',
    overlayIntensity: 0,
    defaultTransition: 'crossfade',
    accent: ACCENT,
    tint: '',
  },
  Travel: {
    colorGrade: 'saturate(1.2) contrast(1.06) brightness(1.02) sepia(0.06)',
    background: '#161210',
    defaultOverlay: 'light_leak',
    overlayIntensity: 0.3,
    defaultTransition: 'whip_pan',
    accent: ACCENT_LIGHT,
    tint: 'rgba(255,200,120,0.07)',
  },
  'Fast Cut': {
    colorGrade: 'saturate(1.25) contrast(1.18) brightness(1.0)',
    background: '#0a0a0c',
    defaultOverlay: 'speed_ramp',
    overlayIntensity: 0.4,
    defaultTransition: 'whip_pan',
    accent: ACCENT,
    tint: 'rgba(236,84,48,0.04)',
  },
  Soft: {
    colorGrade: 'saturate(0.92) contrast(0.94) brightness(1.05) blur(0px)',
    background: '#221c18',
    defaultOverlay: 'grain',
    overlayIntensity: 0.3,
    defaultTransition: 'dissolve',
    accent: ACCENT_LIGHT,
    tint: 'rgba(255,230,210,0.08)',
  },
  Mellow: {
    colorGrade: 'saturate(0.85) contrast(0.96) brightness(1.0) sepia(0.12)',
    background: '#161210',
    defaultOverlay: 'grain',
    overlayIntensity: 0.35,
    defaultTransition: 'dissolve',
    accent: ACCENT_LIGHT,
    tint: 'rgba(200,170,140,0.1)',
  },
};

export function getThemeVisual(theme: ConcreteTheme): ThemeVisual {
  return THEME_VISUALS[theme];
}
