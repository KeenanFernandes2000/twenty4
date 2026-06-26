// Unit tests — beat-aligned EDL builder (M7 §7). Asserts the produced EDL passes
// the strict contracts schema + both runtime invariants, uses EXACTLY the given
// clips, and honors a trimmed subset.
import { describe, expect, test } from "bun:test";
import { edlSchema, edlDurationsSumTo30s, edlCutsOnBeats, type Theme } from "@twenty4/contracts";
import { buildEdl, type EdlTrack } from "../src/intelligence/edl/build.ts";
import type { ScoredClip } from "../src/intelligence/scoring/score.ts";
import { loadBeatGrid, selectTrack } from "../src/montage/tracks.ts";
import { loadWorkerEnv } from "./helpers.ts";

const env = loadWorkerEnv();

// A real precomputed grid (also exercises the tracks loader).
const cleanGrid = loadBeatGrid(env, "clean");
const track: EdlTrack = { id: "clean", bpm: 100, beatGrid: cleanGrid };

function photo(ref: string): ScoredClip {
  return { mediaRef: ref, mediaType: "photo", score: 0.5, durationMs: 0 };
}
function video(ref: string, durationMs: number): ScoredClip {
  return {
    mediaRef: ref,
    mediaType: "video",
    score: 0.7,
    durationMs,
    bestWindowMs: { inMs: Math.round(durationMs * 0.3), outMs: Math.round(durationMs * 0.5) },
  };
}

const THEMES: Theme[] = ["chill", "party", "clean", "travel", "random", "fast_cut", "soft"];

describe("buildEdl — contract + invariants", () => {
  test("passes edlSchema.parse, sums to 30000, cuts on beats (every theme)", () => {
    const clips = [photo("a"), video("b", 8000), photo("c"), video("d", 12000)];
    for (const theme of THEMES) {
      const edl = buildEdl({ scoredClips: clips, track, theme });
      // Strict schema (throws on any drift) — re-parse to be explicit.
      expect(() => edlSchema.parse(edl)).not.toThrow();
      expect(edl.width).toBe(1080);
      expect(edl.height).toBe(1920);
      expect(edl.fps).toBe(30);
      expect(edl.durationMs).toBe(30000);
      expect(edlDurationsSumTo30s(edl)).toBe(true);
      expect(edlCutsOnBeats(edl)).toBe(true);
      expect(edl.musicId).toBe("clean");
      expect(edl.audio.srcRef).toBe("music/clean.wav");
      expect(edl.themeStyle.theme).toBe(theme);
    }
  });

  test("uses EXACTLY the given clips (no others), all of them present", () => {
    const clips = [photo("a"), video("b", 8000), photo("c"), video("d", 12000)];
    const edl = buildEdl({ scoredClips: clips, track, theme: "clean" });
    const used = new Set(edl.segments.map((s) => s.mediaRef));
    expect(used).toEqual(new Set(["a", "b", "c", "d"]));
  });

  test("honors a trimmed subset (remove-media-and-regenerate)", () => {
    const clips = [photo("a"), video("d", 12000)]; // dropped b + c
    const edl = buildEdl({ scoredClips: clips, track, theme: "clean" });
    const used = new Set(edl.segments.map((s) => s.mediaRef));
    expect(used).toEqual(new Set(["a", "d"]));
    expect(edlDurationsSumTo30s(edl)).toBe(true);
    expect(edlCutsOnBeats(edl)).toBe(true);
  });

  test("video segments carry a trim window; photos hold (inMs 0, outMs == durationMs)", () => {
    const clips = [photo("a"), video("d", 12000)];
    const edl = buildEdl({ scoredClips: clips, track, theme: "clean" });
    for (const seg of edl.segments) {
      if (seg.mediaType === "photo") {
        expect(seg.inMs).toBe(0);
        expect(seg.outMs).toBe(seg.durationMs);
      } else {
        expect(seg.outMs - seg.inMs).toBe(seg.durationMs);
        expect(seg.inMs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("video shorter than its segment: source trim never reads past EOF (L4 clamp)", () => {
    // A 500ms clip is far shorter than any clean-track segment (~600–1800ms), so the
    // SOURCE trim window must be clamped to the clip's real length — without the clamp
    // outMs would land past the clip's EOF (OffthreadVideo freeze/black on the tail).
    const shortVid: ScoredClip = { mediaRef: "short", mediaType: "video", score: 0.9, durationMs: 500 };
    const edl = buildEdl({ scoredClips: [photo("a"), shortVid], track, theme: "clean" });
    const vids = edl.segments.filter((s) => s.mediaType === "video");
    expect(vids.length).toBeGreaterThan(0);
    for (const seg of vids) {
      expect(seg.outMs).toBeLessThanOrEqual(500); // never past the source EOF
      expect(seg.inMs).toBeGreaterThanOrEqual(0);
      expect(seg.outMs).toBeGreaterThan(seg.inMs); // non-degenerate window
    }
    // The source-trim clamp must NOT disturb the contract invariants.
    expect(() => edlSchema.parse(edl)).not.toThrow();
    expect(edlDurationsSumTo30s(edl)).toBe(true);
    expect(edlCutsOnBeats(edl)).toBe(true);
  });

  test("selectTrack honours an explicit musicId and falls back by theme", () => {
    expect(selectTrack(env, { musicId: "fast", theme: "chill" }).id).toBe("fast");
    expect(selectTrack(env, { musicId: null, theme: "party" }).id).toBe("party");
    expect(selectTrack(env, { musicId: "nonexistent", theme: "chill" }).id).toBe("chill");
  });
});
