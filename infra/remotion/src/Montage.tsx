import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import type {
  Edl,
  MontageProps,
  Overlay,
  Segment,
  SrcMap,
  Theme,
  Transition,
} from "./types";

const FPS = 30;

const msToFrames = (ms: number): number => Math.round((ms / 1000) * FPS);

// ---------------------------------------------------------------------------
// Per-theme Ken Burns (subtle scale ramp on photos). Cover already implies the
// frame is filled; we add a slow zoom so stills don't feel static.
// ---------------------------------------------------------------------------
const kenBurnsForTheme = (theme: Theme): { from: number; to: number } => {
  switch (theme) {
    case "party":
    case "fast_cut":
      return { from: 1.06, to: 1.16 };
    case "travel":
      return { from: 1.04, to: 1.14 };
    case "clean":
      return { from: 1.02, to: 1.06 };
    case "soft":
    case "chill":
      return { from: 1.03, to: 1.08 };
    default:
      return { from: 1.04, to: 1.1 };
  }
};

// Deterministic fallback color from a string (when a srcMap entry is missing).
const colorFromRef = (ref: string): string => {
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (h * 31 + ref.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 55%, 32%)`;
};

const GRAIN_DATA_URI =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>` +
      `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/>` +
      `<feColorMatrix type='saturate' values='0'/></filter>` +
      `<rect width='100%' height='100%' filter='url(#n)'/></svg>`,
  );

const OverlayLayer: React.FC<{ overlay: Overlay }> = ({ overlay }) => {
  if (overlay === "grain") {
    return (
      <AbsoluteFill
        style={{
          backgroundImage: `url("${GRAIN_DATA_URI}")`,
          backgroundRepeat: "repeat",
          opacity: 0.09,
          mixBlendMode: "overlay",
          pointerEvents: "none",
        }}
      />
    );
  }
  if (overlay === "vignette") {
    return (
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 100%)",
          pointerEvents: "none",
        }}
      />
    );
  }
  return null;
};

// ---------------------------------------------------------------------------
// One placed clip. Lives inside a <Sequence> so useCurrentFrame() is 0-based
// for the duration of THIS segment.
// ---------------------------------------------------------------------------
const SegmentClip: React.FC<{
  segment: Segment;
  durationInFrames: number;
  theme: Theme;
  src: string | undefined;
}> = ({ segment, durationInFrames, theme, src }) => {
  const frame = useCurrentFrame();

  const fade = Math.max(1, Math.min(8, Math.floor(durationInFrames / 3)));
  const transition: Transition = segment.transition;

  // Per-segment opacity + black-dip envelopes that approximate cross-clip
  // transitions (sequences don't overlap, so we fade each clip's own edges).
  let opacity = 1;
  let blackOpacity = 0;
  if (transition === "crossfade") {
    opacity = interpolate(
      frame,
      [0, fade, durationInFrames - fade, durationInFrames],
      [0, 1, 1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
  } else if (transition === "dipToBlack") {
    blackOpacity = interpolate(
      frame,
      [0, fade, durationInFrames - fade, durationInFrames],
      [1, 0, 0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
  }

  const overlay: Overlay = (segment.overlay ?? "none") as Overlay;

  let media: React.ReactNode;
  if (!src) {
    // Robust fallback — never crash on a missing srcMap entry.
    media = (
      <AbsoluteFill
        style={{
          backgroundColor: colorFromRef(segment.mediaRef),
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            color: "rgba(255,255,255,0.7)",
            fontFamily: "sans-serif",
            fontSize: 36,
          }}
        >
          {segment.mediaRef}
        </div>
      </AbsoluteFill>
    );
  } else if (segment.mediaType === "video") {
    media = (
      <OffthreadVideo
        src={src}
        // trim window inMs..outMs (frames). startFrom/endAt per the M7 spec.
        startFrom={msToFrames(segment.inMs)}
        endAt={Math.max(msToFrames(segment.inMs) + 1, msToFrames(segment.outMs))}
        muted
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    );
  } else {
    const kb = kenBurnsForTheme(theme);
    const scale = interpolate(frame, [0, durationInFrames], [kb.from, kb.to], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    media = (
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
        }}
      />
    );
  }

  return (
    <AbsoluteFill style={{ opacity, backgroundColor: "#000" }}>
      <AbsoluteFill>{media}</AbsoluteFill>
      <OverlayLayer overlay={overlay} />
      {blackOpacity > 0 ? (
        <AbsoluteFill style={{ backgroundColor: "#000", opacity: blackOpacity }} />
      ) : null}
    </AbsoluteFill>
  );
};

export const Montage: React.FC<MontageProps> = ({ edl, srcMap }) => {
  const safeSrcMap: SrcMap = srcMap ?? {};
  const theme = edl.themeStyle?.theme ?? "clean";
  // Composition-level overlay default, overridable per-segment.
  const compOverlay = edl.themeStyle?.overlay ?? "none";

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Bundled music track (lives in this project's public/music dir). */}
      <Audio src={staticFile(`music/${edl.audio.musicId}.wav`)} />

      {edl.segments.map((segment, i) => {
        const from = msToFrames(segment.startMs);
        const durationInFrames = Math.max(1, msToFrames(segment.durationMs));
        const seg: Segment = {
          ...segment,
          overlay: segment.overlay ?? compOverlay,
        };
        return (
          <Sequence
            key={`${segment.mediaRef}-${i}`}
            from={from}
            durationInFrames={durationInFrames}
          >
            <SegmentClip
              segment={seg}
              durationInFrames={durationInFrames}
              theme={theme}
              src={safeSrcMap[segment.mediaRef]}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export type { Edl, MontageProps };
