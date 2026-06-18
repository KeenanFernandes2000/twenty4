/**
 * Theme → cut-density / transition / overlay bias params (§7.1 step 4).
 *
 * The EDL builder (`edl/build.ts`) consumes these STRUCTURAL params to decide
 * pacing (how many beats per cut), which transition to place at each boundary,
 * and the default overlay treatment. The *visual* dressing (color grade, tint,
 * filter strings) lives in `infra/remotion/src/theme.ts` and is owned by the
 * renderer — this file aligns with it (same `ConcreteTheme` enum, same
 * `defaultTransition`/`defaultOverlay`) but adds the pacing knobs the renderer
 * does not need.
 *
 * `Random` is resolved to a concrete theme by `resolveTheme()` BEFORE the EDL is
 * emitted (the EDL `themeStyle.theme` is always concrete — contract requirement).
 */
import type { ConcreteTheme, Theme } from '@twenty4/contracts/enums';
import { CONCRETE_THEMES } from '@twenty4/contracts/enums';
import type { OverlayType, TransitionType } from '@twenty4/contracts/edl';

export interface ThemeParams {
  /**
   * Baseline number of beats each cut occupies (snapped to the beat grid). Lower
   * ⇒ faster cutting. High-energy "drop" sections halve this; calm sections may
   * lengthen it. (e.g. Fast Cut = 2 beats/cut, Mellow = 8.)
   */
  beatsPerCut: number;
  /**
   * Minimum beats a segment may shrink to in a high-energy section (floor on the
   * fast-cut acceleration so cuts never get sub-perceptual).
   */
  minBeatsPerCut: number;
  /**
   * Cut-density bias surfaced in the EDL `themeStyle.cutDensityBias` (>1 favours
   * more/shorter cuts). Diagnostic + future-renderer hint; pacing itself is
   * already baked into the segment durations.
   */
  cutDensityBias: number;
  /** Transition placed at every (non-first) segment boundary for this theme. */
  defaultTransition: TransitionType;
  /** Default overlay treatment for the theme (per-segment in the EDL). */
  defaultOverlay: OverlayType;
  /** Overlay strength 0..1 written into the EDL overlay `intensity`. */
  overlayIntensity: number;
  /**
   * Transition duration as a fraction of one beat (clamped by `maxTransitionMs`).
   * Hard cuts ignore this (duration 0).
   */
  transitionBeatFraction: number;
  /** Absolute ceiling on a transition's duration (ms). */
  maxTransitionMs: number;
}

/**
 * Per-theme structural params. Aligned with `infra/remotion/src/theme.ts`
 * (`defaultTransition`/`defaultOverlay` match) so the EDL the builder emits and
 * the visual the renderer applies agree.
 */
export const THEME_PARAMS: Record<ConcreteTheme, ThemeParams> = {
  Chill: {
    beatsPerCut: 6,
    minBeatsPerCut: 3,
    cutDensityBias: 0.7,
    defaultTransition: 'crossfade',
    defaultOverlay: 'light_leak',
    overlayIntensity: 0.25,
    transitionBeatFraction: 0.75,
    maxTransitionMs: 500,
  },
  Party: {
    beatsPerCut: 4,
    minBeatsPerCut: 2,
    cutDensityBias: 1.3,
    defaultTransition: 'cut',
    defaultOverlay: 'flash',
    overlayIntensity: 0.5,
    transitionBeatFraction: 0.5,
    maxTransitionMs: 320,
  },
  Clean: {
    beatsPerCut: 4,
    minBeatsPerCut: 2,
    cutDensityBias: 1.0,
    defaultTransition: 'crossfade',
    defaultOverlay: 'none',
    overlayIntensity: 0,
    transitionBeatFraction: 0.5,
    maxTransitionMs: 300,
  },
  Travel: {
    beatsPerCut: 4,
    minBeatsPerCut: 2,
    cutDensityBias: 1.1,
    defaultTransition: 'whip_pan',
    defaultOverlay: 'light_leak',
    overlayIntensity: 0.3,
    transitionBeatFraction: 0.4,
    maxTransitionMs: 280,
  },
  'Fast Cut': {
    beatsPerCut: 2,
    minBeatsPerCut: 1,
    cutDensityBias: 1.8,
    defaultTransition: 'whip_pan',
    defaultOverlay: 'speed_ramp',
    overlayIntensity: 0.4,
    transitionBeatFraction: 0.35,
    maxTransitionMs: 220,
  },
  Soft: {
    beatsPerCut: 6,
    minBeatsPerCut: 3,
    cutDensityBias: 0.7,
    defaultTransition: 'dissolve',
    defaultOverlay: 'grain',
    overlayIntensity: 0.3,
    transitionBeatFraction: 0.9,
    maxTransitionMs: 600,
  },
  Mellow: {
    beatsPerCut: 8,
    minBeatsPerCut: 4,
    cutDensityBias: 0.6,
    defaultTransition: 'dissolve',
    defaultOverlay: 'grain',
    overlayIntensity: 0.35,
    transitionBeatFraction: 0.9,
    maxTransitionMs: 700,
  },
};

export function getThemeParams(theme: ConcreteTheme): ThemeParams {
  return THEME_PARAMS[theme];
}

/**
 * Resolve a (possibly `Random`) theme request to a concrete theme.
 *
 * Deterministic: `Random` is resolved by hashing a stable `seed` (e.g. the media
 * pool size or a montage id) into the concrete-theme list, so the same inputs
 * always yield the same theme — required for a reproducible render gate.
 */
export function resolveTheme(theme: Theme, seed = 0): ConcreteTheme {
  if (theme !== 'Random') return theme;
  const idx = Math.abs(Math.trunc(seed)) % CONCRETE_THEMES.length;
  return CONCRETE_THEMES[idx]!;
}
