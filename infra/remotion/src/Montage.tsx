/**
 * <Montage/> — the twenty4 montage composition (§7.2/§7.3).
 *
 * INPUT CONTRACT: it consumes an `Edl` (`@twenty4/contracts/edl`) as inputProps.
 * The renderer makes NO creative decisions — every cut, trim, transition, overlay
 * and the music choice come from the EDL. Output: 1080×1920 / 30fps / 30s.
 *
 * Media resolution: the EDL only carries `mediaRef` (S3 keys, no URLs — §11). The
 * renderer resolves those to browser-loadable sources and passes them via the
 * SEPARATE `srcMap` prop (kept out of the EDL so the EDL contract is untouched).
 * If a ref isn't in `srcMap`, we fall back to `staticFile(mediaRef)` (used by the
 * Studio default props / bundled samples).
 *
 * Determinism: layout is derived entirely from the EDL's ms fields + the comp
 * fps; no randomness, no wall-clock — repeated renders are byte-stable.
 */
import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useVideoConfig,
} from 'remotion';
import { edlSchema, type Edl } from '@twenty4/contracts/edl';
import { getThemeVisual } from './theme';
import { Segment } from './components/Segment';
import { getTrack } from './music/tracks';

/**
 * Composition props: the EDL + an out-of-band media source map.
 *
 * Remotion requires composition props to be an index-signature record, so this
 * is a `type` with a `[key: string]: unknown` tail (Remotion 4 constraint).
 */
export type MontageProps = {
  edl: Edl;
  /** mediaRef → browser-loadable src (file://, http(s), or public-relative). */
  srcMap?: Record<string, string>;
  // Remotion's `Composition` props must extend Record<string, unknown>.
  [key: string]: unknown;
};

const msToFrames = (ms: number, fps: number) => Math.round((ms / 1000) * fps);

export const Montage: React.FC<MontageProps> = ({ edl: rawEdl, srcMap }) => {
  const { fps } = useVideoConfig();

  // Validate against the contract — fail loudly if the intelligence emits garbage.
  const edl: Edl = edlSchema.parse(rawEdl);

  const theme = getThemeVisual(edl.themeStyle.theme);
  const beatsMs = edl.beatGrid.beatsMs;

  // Resolve the music file from the bundled registry; play from the EDL offset.
  const track = getTrack(edl.audio.musicId);
  const audioSrc = staticFile(track.file);

  const resolveSrc = (mediaRef: string): string => {
    const mapped = srcMap?.[mediaRef];
    if (mapped) return mapped;
    // Fall back to a bundled static asset (Studio defaults / sample EDLs).
    return staticFile(mediaRef);
  };

  // Segments are ordered by `index`; render each in its own Sequence placed at
  // `startMs`. We extend each Sequence by the NEXT segment's transition-in
  // duration so the outgoing clip stays mounted under the incoming blend.
  const segments = [...edl.segments].sort((a, b) => a.index - b.index);

  return (
    <AbsoluteFill style={{ backgroundColor: theme.background }}>
      {segments.map((seg, i) => {
        const from = msToFrames(seg.startMs, fps);
        const baseDur = Math.max(1, msToFrames(seg.durationMs, fps));
        // Overlap with the next segment's incoming transition so both are mounted.
        const next = segments[i + 1];
        const overlapMs =
          next?.transitionIn && next.transitionIn.type !== 'cut'
            ? next.transitionIn.durationMs
            : 0;
        const durationInFrames = baseDur + msToFrames(overlapMs, fps);

        return (
          <Sequence
            key={seg.index}
            from={from}
            durationInFrames={durationInFrames}
            name={`seg-${seg.index}-${seg.mediaType}`}
            layout="none"
          >
            <Segment
              segment={seg}
              src={resolveSrc(seg.mediaRef)}
              theme={theme}
              beatsMs={beatsMs}
            />
          </Sequence>
        );
      })}

      {/* Music bed — single track, started at the EDL offset, master volume. */}
      <Audio
        src={audioSrc}
        startFrom={msToFrames(edl.audio.startMs, fps)}
        volume={edl.audio.volume}
      />
    </AbsoluteFill>
  );
};
