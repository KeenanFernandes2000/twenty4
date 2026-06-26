// Unit tests — intelligence scoring (M7 §7). Pure: scores fixture files directly
// (no S3). A photo returns a near-flat score with NO bestWindow; a video returns a
// sane score WITH a bestWindow inside its source duration.
import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreClip } from "../src/intelligence/scoring/score.ts";
import { fixture } from "./helpers.ts";

const PHOTO = "IMG20260522212401.jpg";
const VIDEO = "VID20260524170711.mp4";

// scoreClip takes a local path; stage the fixtures into a temp dir.
const dir = mkdtempSync(join(tmpdir(), "t4score-test-"));
function stage(name: string): string {
  const p = join(dir, name);
  writeFileSync(p, fixture(name));
  return p;
}

describe("scoreClip — photo", () => {
  test("flat-ish score in (0,1), no bestWindow, durationMs 0", async () => {
    const r = await scoreClip({ mediaRef: "p1", mediaType: "photo", path: stage(PHOTO) });
    expect(r.mediaRef).toBe("p1");
    expect(r.mediaType).toBe("photo");
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(1);
    // Photos sit near the flat 0.5 baseline (nudge is bounded to ±0.1).
    expect(Math.abs(r.score - 0.5)).toBeLessThanOrEqual(0.12);
    expect(r.bestWindowMs).toBeUndefined();
    expect(r.durationMs).toBe(0);
  });
});

describe("scoreClip — video", () => {
  test("sane score + a bestWindow inside the source duration", async () => {
    const r = await scoreClip({ mediaRef: "v1", mediaType: "video", path: stage(VIDEO) });
    expect(r.mediaType).toBe("video");
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.durationMs).toBeGreaterThan(0);
    // ffmpeg is on the box → not degraded, and a highlight window is chosen.
    expect(r.degraded).toBeFalsy();
    expect(r.bestWindowMs).toBeDefined();
    expect(r.bestWindowMs!.inMs).toBeGreaterThanOrEqual(0);
    expect(r.bestWindowMs!.outMs).toBeGreaterThan(r.bestWindowMs!.inMs);
    expect(r.bestWindowMs!.outMs).toBeLessThanOrEqual(r.durationMs);
  }, 60_000);
});
