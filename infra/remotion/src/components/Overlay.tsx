/**
 * Overlay — per-segment theme treatment (§7.1 step 4 / EDL `overlay`).
 *
 * Each overlay type from the contracts `OVERLAY_TYPES` enum is rendered as a
 * deterministic, full-frame absolutely-positioned layer ON TOP of the media.
 * Determinism: everything is derived from `useCurrentFrame()` + the beat grid —
 * no Math.random(), no Date.now() — so repeated renders are byte-stable.
 */
import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { Overlay as EdlOverlay } from '@twenty4/contracts/edl';

/**
 * Tile size for the baked grain noise. 256px tiles seamlessly (stitchTiles) and
 * costs ~30× less to rasterize than the full 1080×1920 canvas while looking the
 * same at viewing distance.
 */
const GRAIN_TILE = 256;

interface OverlayProps {
  overlay: EdlOverlay;
  /** Theme accent (chrome color for caption/date chips). */
  accent: string;
  /** Beat times (ms) within the whole montage — used by `flash`. */
  beatsMs: number[];
}

/** Closest beat distance (ms) for the current time — drives flash decay. */
function msSinceLastBeat(timeMs: number, beatsMs: number[]): number {
  let last = 0;
  for (const b of beatsMs) {
    if (b <= timeMs) last = b;
    else break;
  }
  return timeMs - last;
}

export const Overlay: React.FC<OverlayProps> = ({ overlay, accent, beatsMs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeMs = (frame / fps) * 1000;
  const intensity = overlay.intensity ?? 0.3;

  switch (overlay.type) {
    case 'none':
      return null;

    case 'grain': {
      // Static SVG fractal-noise grain; opacity scales with intensity.
      // Deterministic (no per-frame jitter to keep encodes stable).
      //
      // PERF: feTurbulence is rasterized by Chrome, so we bake it into a small
      // `GRAIN_TILE`×`GRAIN_TILE` SVG and `background-repeat` it instead of filtering
      // the full 1080×1920 canvas — same look, less raster work. (The real §10 win
      // was disabling the shared-GPU GL path in the renderer; this is a cheap extra.)
      // `stitchTiles="stitch"` keeps the tile seamless.
      const svg = `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${GRAIN_TILE}" height="${GRAIN_TILE}"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)" opacity="1"/></svg>`,
      )}`;
      return (
        <AbsoluteFill
          style={{
            backgroundImage: `url("${svg}")`,
            backgroundRepeat: 'repeat',
            backgroundSize: `${GRAIN_TILE}px ${GRAIN_TILE}px`,
            mixBlendMode: 'overlay',
            opacity: 0.18 * (intensity / 0.3),
            pointerEvents: 'none',
          }}
        />
      );
    }

    case 'vignette':
      return (
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,${0.55 * intensity}) 100%)`,
            pointerEvents: 'none',
          }}
        />
      );

    case 'light_leak': {
      // Two soft warm gradients that slowly drift with frame (deterministic).
      const drift = interpolate(frame, [0, 60], [0, 8], {
        extrapolateRight: 'extend',
      });
      return (
        <AbsoluteFill style={{ pointerEvents: 'none', opacity: intensity }}>
          <AbsoluteFill
            style={{
              background: `radial-gradient(circle at ${20 + drift}% 12%, rgba(255,170,90,0.55), rgba(255,170,90,0) 38%)`,
              mixBlendMode: 'screen',
            }}
          />
          <AbsoluteFill
            style={{
              background: `radial-gradient(circle at ${85 - drift}% 90%, rgba(236,84,48,0.45), rgba(236,84,48,0) 40%)`,
              mixBlendMode: 'screen',
            }}
          />
        </AbsoluteFill>
      );
    }

    case 'flash': {
      // Beat-synced white flash that decays over ~120ms after each beat.
      const since = msSinceLastBeat(timeMs, beatsMs);
      const a = since < 120 ? interpolate(since, [0, 120], [0.5 * intensity, 0]) : 0;
      return (
        <AbsoluteFill
          style={{ backgroundColor: `rgba(255,255,255,${a})`, pointerEvents: 'none' }}
        />
      );
    }

    case 'speed_ramp':
      // A subtle directional motion-streak band (visual speed indicator).
      return (
        <AbsoluteFill
          style={{
            background: `linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,${0.12 * intensity}) 50%, rgba(255,255,255,0) 100%)`,
            mixBlendMode: 'screen',
            pointerEvents: 'none',
          }}
        />
      );

    case 'date_stamp':
      return (
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <div
            style={{
              position: 'absolute',
              bottom: 72,
              left: 48,
              padding: '10px 18px',
              borderRadius: 999,
              backgroundColor: 'rgba(0,0,0,0.45)',
              color: '#fff',
              fontFamily: 'sans-serif',
              fontSize: 34,
              fontWeight: 700,
              letterSpacing: 0.5,
              borderLeft: `4px solid ${accent}`,
            }}
          >
            {overlay.text ?? 'today'}
          </div>
        </AbsoluteFill>
      );

    case 'caption':
      return (
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <div
            style={{
              position: 'absolute',
              bottom: 140,
              left: 0,
              right: 0,
              textAlign: 'center',
              color: '#fff',
              fontFamily: 'sans-serif',
              fontSize: 40,
              fontWeight: 800,
              textShadow: '0 2px 12px rgba(0,0,0,0.6)',
            }}
          >
            {overlay.text ?? ''}
          </div>
        </AbsoluteFill>
      );

    default:
      return null;
  }
};
