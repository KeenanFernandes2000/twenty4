import { expect, test } from "bun:test";
import { edlCutsOnBeats, edlDurationsSumTo30s, edlSchema, type Edl } from "./edl.ts";

// A hand-built valid EDL: 3 segments of 10s each, cutting on the track grid.
const validEdl: Edl = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationMs: 30000,
  musicId: "synth-01",
  themeStyle: {
    theme: "chill",
    transition: "crossfade",
    cutDensity: 0.4,
    overlay: "grain",
  },
  audio: {
    musicId: "synth-01",
    srcRef: "music/synth-01.wav",
    beatGrid: [0, 5000, 10000, 15000, 20000, 25000],
  },
  segments: [
    {
      mediaRef: "11111111-1111-1111-1111-111111111111",
      mediaType: "photo",
      inMs: 0,
      outMs: 30000,
      startMs: 0,
      durationMs: 10000,
      transition: "cut",
      overlay: null,
    },
    {
      mediaRef: "22222222-2222-2222-2222-222222222222",
      mediaType: "video",
      inMs: 2000,
      outMs: 12000,
      startMs: 10000,
      durationMs: 10000,
      transition: "crossfade",
    },
    {
      mediaRef: "33333333-3333-3333-3333-333333333333",
      mediaType: "video",
      inMs: 0,
      outMs: 10000,
      startMs: 20000,
      durationMs: 10000,
      transition: "crossfade",
      overlay: "vignette",
    },
  ],
  beatGrid: [0, 5000, 10000, 15000, 20000, 25000],
};

test("a hand-built valid EDL passes", () => {
  expect(edlSchema.safeParse(validEdl).success).toBe(true);
});

test(".strict() rejects an extra top-level key", () => {
  const bad = { ...validEdl, extra: "nope" };
  expect(edlSchema.safeParse(bad).success).toBe(false);
});

test(".strict() rejects an extra key inside a segment", () => {
  const bad = {
    ...validEdl,
    segments: [{ ...validEdl.segments[0], bogus: 1 }, ...validEdl.segments.slice(1)],
  };
  expect(edlSchema.safeParse(bad).success).toBe(false);
});

test("a wrong literal (width 1920) is rejected", () => {
  const bad = { ...validEdl, width: 1920 };
  expect(edlSchema.safeParse(bad).success).toBe(false);
});

test("wrong fps / durationMs / height literals are rejected", () => {
  expect(edlSchema.safeParse({ ...validEdl, fps: 24 }).success).toBe(false);
  expect(edlSchema.safeParse({ ...validEdl, durationMs: 15000 }).success).toBe(false);
  expect(edlSchema.safeParse({ ...validEdl, height: 1080 }).success).toBe(false);
});

test("empty segments array is rejected (.min(1))", () => {
  expect(edlSchema.safeParse({ ...validEdl, segments: [] }).success).toBe(false);
});

test("edlDurationsSumTo30s is true for a Σ=30000 EDL", () => {
  expect(edlDurationsSumTo30s(validEdl)).toBe(true);
});

test("edlDurationsSumTo30s is false when durations don't sum to 30000", () => {
  const off: Edl = {
    ...validEdl,
    segments: [
      { ...validEdl.segments[0]!, durationMs: 10000 },
      { ...validEdl.segments[1]!, durationMs: 10000 },
      { ...validEdl.segments[2]!, durationMs: 5000 }, // Σ = 25000
    ],
  };
  expect(edlDurationsSumTo30s(off)).toBe(false);
});

test("edlCutsOnBeats is true when every start aligns with the grid", () => {
  expect(edlCutsOnBeats(validEdl)).toBe(true);
});

test("edlCutsOnBeats allows the first segment at startMs=0 even off-grid", () => {
  const e: Edl = { ...validEdl, beatGrid: [10000, 20000] }; // 0 not a beat
  expect(edlCutsOnBeats(e)).toBe(true);
});

test("edlCutsOnBeats is false when a cut is off-beat beyond tolerance", () => {
  const off: Edl = {
    ...validEdl,
    segments: [
      { ...validEdl.segments[0]! },
      { ...validEdl.segments[1]!, startMs: 12345 }, // not within 60ms of any beat
      { ...validEdl.segments[2]! },
    ],
  };
  expect(edlCutsOnBeats(off)).toBe(false);
});

test("edlCutsOnBeats respects a widened tolerance", () => {
  const e: Edl = {
    ...validEdl,
    segments: [
      { ...validEdl.segments[0]! },
      { ...validEdl.segments[1]!, startMs: 10040 }, // 40ms off the 10000 beat
      { ...validEdl.segments[2]! },
    ],
  };
  expect(edlCutsOnBeats(e, 20)).toBe(false);
  expect(edlCutsOnBeats(e, 60)).toBe(true);
});
