/**
 * Transition — computes the entry animation for a segment based on its
 * `transitionIn` (from the EDL). Returns a style fragment (opacity / transform /
 * filter) applied to the segment wrapper for the first `durationMs` of the clip.
 *
 * We implement transitions as ENTRY animations on each segment (the incoming
 * clip animates in over the outgoing one, which sits in the previous Sequence).
 * Remotion `Sequence`s overlap by the transition duration so both are mounted
 * during the blend. A `cut` (durationMs 0) is an instantaneous swap.
 *
 * All math is frame-derived → deterministic.
 */
import { interpolate, Easing } from 'remotion';
import type { Transition, TransitionType } from '@twenty4/contracts/edl';

export interface TransitionStyle {
  opacity: number;
  transform: string;
  filter: string;
}

const NEUTRAL: TransitionStyle = { opacity: 1, transform: 'none', filter: 'none' };

/**
 * @param transition  the EDL transitionIn (or undefined → hard cut)
 * @param frame       current frame WITHIN the segment's sequence (0-based)
 * @param fps         composition fps
 */
export function transitionInStyle(
  transition: Transition | undefined,
  frame: number,
  fps: number,
): TransitionStyle {
  if (!transition || transition.durationMs <= 0 || transition.type === 'cut') {
    return NEUTRAL;
  }
  const durFrames = Math.max(1, Math.round((transition.durationMs / 1000) * fps));
  if (frame >= durFrames) return NEUTRAL;

  const t = interpolate(frame, [0, durFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });

  return styleFor(transition.type, t);
}

function styleFor(type: TransitionType, t: number): TransitionStyle {
  switch (type) {
    case 'crossfade':
    case 'dissolve':
      return { opacity: t, transform: 'none', filter: 'none' };

    case 'fade_through_black':
      // First half: incoming stays black-dark and fades up in second half.
      return {
        opacity: interpolate(t, [0, 0.5, 1], [0, 0, 1], { extrapolateRight: 'clamp' }),
        transform: 'none',
        filter: `brightness(${interpolate(t, [0, 0.5, 1], [0.2, 0.4, 1])})`,
      };

    case 'whip_pan': {
      // Slide + motion blur in from the right.
      const x = interpolate(t, [0, 1], [60, 0]);
      const blur = interpolate(t, [0, 0.6, 1], [22, 6, 0], {
        extrapolateRight: 'clamp',
      });
      return {
        opacity: interpolate(t, [0, 0.3, 1], [0, 1, 1]),
        transform: `translateX(${x}%)`,
        filter: `blur(${blur}px)`,
      };
    }

    case 'zoom_blur': {
      const scale = interpolate(t, [0, 1], [1.25, 1]);
      const blur = interpolate(t, [0, 1], [18, 0]);
      return {
        opacity: interpolate(t, [0, 0.3, 1], [0, 1, 1]),
        transform: `scale(${scale})`,
        filter: `blur(${blur}px)`,
      };
    }

    case 'cut':
    default:
      return NEUTRAL;
  }
}
