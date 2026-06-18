/**
 * Root — registers the `<Montage/>` composition.
 *
 * Fixed canvas (§10 output): 1080×1920, 30fps, 900 frames (30s). `calculateMetadata`
 * lets the worker pass an EDL whose `durationMs`/`fps` derive the real frame count
 * (kept at the 30s default for the prototype, but the seam exists).
 */
import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import {
  EDL_DURATION_MS,
  EDL_FPS,
  EDL_HEIGHT,
  EDL_WIDTH,
} from '@twenty4/contracts/edl';
import { Montage, type MontageProps } from './Montage';
import { SAMPLE_EDL } from './sampleEdl';

const calculateMetadata: CalculateMetadataFunction<MontageProps> = ({ props }) => {
  const edl = props.edl;
  const fps = edl?.fps ?? EDL_FPS;
  const durationMs = edl?.durationMs ?? EDL_DURATION_MS;
  return {
    durationInFrames: Math.round((durationMs / 1000) * fps),
    fps,
    width: edl?.width ?? EDL_WIDTH,
    height: edl?.height ?? EDL_HEIGHT,
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Montage"
      component={Montage}
      width={EDL_WIDTH}
      height={EDL_HEIGHT}
      fps={EDL_FPS}
      durationInFrames={(EDL_DURATION_MS / 1000) * EDL_FPS}
      defaultProps={{ edl: SAMPLE_EDL } satisfies MontageProps}
      calculateMetadata={calculateMetadata}
    />
  );
};
