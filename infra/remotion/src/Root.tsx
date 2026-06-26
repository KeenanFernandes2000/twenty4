import React from "react";
import { Composition } from "remotion";
import { Montage } from "./Montage";
import type { Edl, MontageProps } from "./types";

// Minimal VALID default EDL — used by `remotion studio` previews and as the
// schema for defaultProps. At render time the driver overrides these inputProps
// with the real, Zod-validated EDL + an http srcMap. The default references no
// real media, so SegmentClip renders its colored fallback frames (proving the
// composition is robust to a missing srcMap).
const defaultEdl: Edl = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationMs: 30000,
  musicId: "chill",
  themeStyle: {
    theme: "chill",
    transition: "crossfade",
    cutDensity: 0.5,
    overlay: "vignette",
  },
  audio: {
    musicId: "chill",
    srcRef: "music/chill.wav",
    beatGrid: [0, 666, 1333, 2000, 2666, 3333, 4000],
  },
  segments: [
    {
      mediaRef: "demo/1",
      mediaType: "photo",
      inMs: 0,
      outMs: 0,
      startMs: 0,
      durationMs: 10000,
      transition: "crossfade",
      overlay: "vignette",
    },
    {
      mediaRef: "demo/2",
      mediaType: "photo",
      inMs: 0,
      outMs: 0,
      startMs: 10000,
      durationMs: 10000,
      transition: "dipToBlack",
      overlay: "grain",
    },
    {
      mediaRef: "demo/3",
      mediaType: "photo",
      inMs: 0,
      outMs: 0,
      startMs: 20000,
      durationMs: 10000,
      transition: "cut",
      overlay: "none",
    },
  ],
  beatGrid: [0, 666, 1333, 2000, 2666, 3333, 4000],
};

const defaultProps: MontageProps = { edl: defaultEdl, srcMap: {} };

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Montage"
      component={Montage}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={900}
      defaultProps={defaultProps}
      // Derive timeline length / dimensions from the EDL so the driver's real
      // EDL drives the metadata (still 1080x1920/30fps/900 for the M7 contract).
      calculateMetadata={({ props }) => {
        const edl = props.edl ?? defaultEdl;
        return {
          durationInFrames: Math.max(
            1,
            Math.round((edl.durationMs / 1000) * edl.fps),
          ),
          width: edl.width,
          height: edl.height,
          fps: edl.fps,
        };
      }}
    />
  );
};
