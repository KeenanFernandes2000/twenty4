/**
 * Sample / helper EDLs.
 *
 * `buildBeatAlignedEdl` constructs a VALID, gapless, beat-aligned 30s EDL from a
 * list of media refs + a bundled track. It is a tiny stand-in for the real
 * intelligence layer (added later in `@twenty4/worker`) — just enough to (a) give
 * the Studio realistic default props and (b) drive the render smoke test. It
 * emits EXACTLY the `@twenty4/contracts/edl` shape (validated below).
 *
 * Allocation rule: walk the beat grid, give each media item ~`beatsPerSegment`
 * beats (snapped to the grid), cycling through the refs until the 30s window is
 * filled gaplessly. Cuts therefore always land on a beat.
 */
import {
  EDL_DURATION_MS,
  edlSchema,
  type Edl,
  type EdlSegment,
  type Transition,
  type TransitionType,
} from '@twenty4/contracts/edl';
import type { ConcreteTheme, MediaType } from '@twenty4/contracts/enums';
import { getTrack } from './music/tracks';
import { getThemeVisual } from './theme';

export interface SampleMediaItem {
  mediaRef: string;
  mediaType: MediaType;
  /** For video: the source clip length (ms). Photos: ignored (held). */
  sourceDurationMs?: number;
}

export interface BuildEdlOptions {
  musicId: string;
  theme: ConcreteTheme;
  media: SampleMediaItem[];
  /** Approx beats each segment occupies (snapped to the grid). Default 4. */
  beatsPerSegment?: number;
  /** Audio offset into the track (ms). Default 0. */
  audioStartMs?: number;
}

function mkTransition(type: TransitionType, durationMs: number): Transition {
  return { type, durationMs };
}

export function buildBeatAlignedEdl(opts: BuildEdlOptions): Edl {
  const track = getTrack(opts.musicId);
  const themeVisual = getThemeVisual(opts.theme);
  const beatsPerSegment = Math.max(1, opts.beatsPerSegment ?? 4);

  // Beats that fall inside the 30s output window (plus the closing edge).
  const beats = track.beatGridMs.filter((b) => b <= EDL_DURATION_MS);
  if (beats[beats.length - 1]! < EDL_DURATION_MS) beats.push(EDL_DURATION_MS);

  const segments: EdlSegment[] = [];
  let beatIdx = 0;
  let mediaIdx = 0;
  let segIndex = 0;

  while (beatIdx < beats.length - 1 && beats[beatIdx]! < EDL_DURATION_MS) {
    const startMs = beats[beatIdx]!;
    // Land the cut `beatsPerSegment` beats later, clamped to the 30s edge.
    const endBeatIdx = Math.min(beatIdx + beatsPerSegment, beats.length - 1);
    let endMs = beats[endBeatIdx]!;
    if (endMs > EDL_DURATION_MS) endMs = EDL_DURATION_MS;
    if (endMs <= startMs) break;

    const durationMs = endMs - startMs;
    const item = opts.media[mediaIdx % opts.media.length]!;

    const isVideo = item.mediaType === 'video';
    // Video: trim a beat-aligned window of `durationMs` from the source start.
    // Clamp to the source length so inMs/outMs stay valid.
    const srcLen = item.sourceDurationMs ?? durationMs;
    const inMs = 0;
    const outMs = isVideo ? Math.min(srcLen, durationMs) : durationMs;

    // Transition INTO this segment: theme default, ~half a beat, except the first.
    const beatMs = 60_000 / track.bpm;
    const transDurMs = Math.round(Math.min(beatMs / 2, 320));
    const transType = themeVisual.defaultTransition;
    const transitionIn: Transition | undefined =
      segIndex === 0 ? undefined : mkTransition(transType, transDurMs);

    segments.push({
      index: segIndex,
      mediaRef: item.mediaRef,
      mediaType: item.mediaType,
      inMs,
      outMs,
      startMs,
      durationMs,
      speed: 1,
      transitionIn,
      transitionOut:
        endMs >= EDL_DURATION_MS ? undefined : mkTransition(transType, transDurMs),
      overlay:
        themeVisual.defaultOverlay === 'none'
          ? undefined
          : { type: themeVisual.defaultOverlay, intensity: themeVisual.overlayIntensity },
      score: 0.8,
    });

    segIndex += 1;
    mediaIdx += 1;
    beatIdx = endBeatIdx;
  }

  const edl: Edl = {
    version: 1,
    width: 1080,
    height: 1920,
    fps: 30,
    aspect: '9:16',
    durationMs: EDL_DURATION_MS,
    audio: {
      musicId: opts.musicId,
      startMs: opts.audioStartMs ?? 0,
      volume: 0.9,
    },
    beatGrid: {
      bpm: track.bpm,
      beatsMs: beats,
      dropsMs: track.dropsMs.filter((d) => d <= EDL_DURATION_MS),
    },
    themeStyle: {
      theme: opts.theme,
      defaultTransition: themeVisual.defaultTransition,
      cutDensityBias: 1,
      colorGrade: opts.theme.toLowerCase().replace(/\s+/g, '_'),
      overlay:
        themeVisual.defaultOverlay === 'none'
          ? undefined
          : { type: themeVisual.defaultOverlay, intensity: themeVisual.overlayIntensity },
    },
    segments,
  };

  // Always validate — the helper must never emit an invalid EDL.
  return edlSchema.parse(edl);
}

/**
 * The default sample EDL for the Studio. Uses bundled placeholder images under
 * `public/samples/` (resolved via staticFile fallback in <Montage/>). Real media
 * is fed by the worker via `srcMap` at render time.
 */
export const SAMPLE_EDL: Edl = buildBeatAlignedEdl({
  musicId: 'house_120',
  theme: 'Party',
  beatsPerSegment: 4,
  media: [
    { mediaRef: 'samples/sample-1.jpg', mediaType: 'photo' },
    { mediaRef: 'samples/sample-2.jpg', mediaType: 'photo' },
    { mediaRef: 'samples/sample-3.jpg', mediaType: 'photo' },
  ],
});
