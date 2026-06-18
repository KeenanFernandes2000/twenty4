/**
 * Segment — renders ONE EDL segment inside its own `<Sequence>`.
 *
 *  - video: `<OffthreadVideo>` with source trim (`startFrom`/`endAt` derived from
 *    `inMs`/`outMs`) and `playbackRate` from `speed`.
 *  - photo: `<Img>` held for the segment duration with a deterministic, slow
 *    Ken-Burns zoom so stills don't feel static.
 *
 * The theme color-grade + tint, the transition-IN animation, and the overlay are
 * all layered on top. Media is `object-fit: cover` onto the 1080×1920 canvas.
 *
 * `srcResolver` maps an EDL `mediaRef` (an S3 key in production) to something the
 * browser can load: a `file://` path, an http(s) URL, or a `staticFile()` path.
 * The renderer injects it so this component stays storage-agnostic.
 */
import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { EdlSegment } from '@twenty4/contracts/edl';
import type { ThemeVisual } from '../theme';
import { Overlay } from './Overlay';
import { transitionInStyle } from './Transition';

interface SegmentProps {
  segment: EdlSegment;
  /** Resolved, browser-loadable source for `segment.mediaRef`. */
  src: string;
  theme: ThemeVisual;
  /** Whole-montage beat times (ms) for beat-synced overlays. */
  beatsMs: number[];
}

export const Segment: React.FC<SegmentProps> = ({ segment, src, theme, beatsMs }) => {
  const frame = useCurrentFrame(); // 0-based WITHIN this segment's Sequence
  const { fps } = useVideoConfig();

  const trans = transitionInStyle(segment.transitionIn, frame, fps);

  // Per-segment effective overlay: EDL segment overlay wins; else theme default.
  const overlay =
    segment.overlay ??
    (theme.defaultOverlay === 'none'
      ? undefined
      : { type: theme.defaultOverlay, intensity: theme.overlayIntensity });

  const mediaStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    filter: `${theme.colorGrade} ${trans.filter !== 'none' ? trans.filter : ''}`.trim(),
  };

  return (
    <AbsoluteFill
      style={{
        background: theme.background,
        opacity: trans.opacity,
        transform: trans.transform,
      }}
    >
      {segment.mediaType === 'video' ? (
        <OffthreadVideo
          src={src}
          // Source trim → seconds. `startFrom`/`endAt` are in frames in v4.
          startFrom={Math.round((segment.inMs / 1000) * fps)}
          endAt={Math.max(
            Math.round((segment.inMs / 1000) * fps) + 1,
            Math.round((segment.outMs / 1000) * fps),
          )}
          playbackRate={segment.speed ?? 1}
          muted // montage audio is the music bed, never clip audio
          style={mediaStyle}
        />
      ) : (
        <Img
          src={src}
          style={{
            ...mediaStyle,
            // Slow deterministic Ken-Burns zoom over the hold.
            transform: `scale(${interpolate(
              frame,
              [0, Math.max(1, Math.round((segment.durationMs / 1000) * fps))],
              [1.0, 1.08],
              { extrapolateRight: 'clamp' },
            )})`,
          }}
        />
      )}

      {/* Theme mood tint */}
      {theme.tint ? (
        <AbsoluteFill style={{ backgroundColor: theme.tint, pointerEvents: 'none' }} />
      ) : null}

      {/* Overlay treatment */}
      {overlay ? (
        <Overlay overlay={overlay} accent={theme.accent} beatsMs={beatsMs} />
      ) : null}
    </AbsoluteFill>
  );
};
