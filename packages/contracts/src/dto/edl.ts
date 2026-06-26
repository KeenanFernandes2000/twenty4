// EDL (Edit Decision List) — the single cross-team contract for the montage
// render (M7 §2/§3). DELIBERATE departure from house DTO style: this schema is
// `.strict()` with `1080×1920 / 30fps / 30000ms` as LITERALS, because the
// Remotion composition + render driver + API + worker are all built in parallel
// against this exact JSON shape — it is the single source of truth. Do NOT relax
// `.strict()` or change a literal without updating every consumer in lockstep.
import { z } from "zod";
import { themeEnum } from "./montageEnums.ts";

// Transition + overlay vocabularies — shared by themeStyle and each segment.
const transitionEnum = z.enum(["cut", "crossfade", "dipToBlack"]);
const overlayEnum = z.enum(["none", "grain", "vignette"]);

export const edlSchema = z
  .object({
    width: z.literal(1080),
    height: z.literal(1920),
    fps: z.literal(30),
    durationMs: z.literal(30000),
    musicId: z.string(),
    themeStyle: z
      .object({
        theme: themeEnum,
        transition: transitionEnum,
        cutDensity: z.number(), // 0..1 pacing bias
        overlay: overlayEnum,
      })
      .strict(),
    audio: z
      .object({
        musicId: z.string(),
        srcRef: z.string(), // e.g. "music/<id>.wav"
        beatGrid: z.array(z.number()), // beat onset times in MILLISECONDS from track start
      })
      .strict(),
    segments: z
      .array(
        z
          .object({
            mediaRef: z.string(), // daily_media_item id
            mediaType: z.enum(["photo", "video"]),
            inMs: z.number(), // source trim start (0 for photo)
            outMs: z.number(), // source trim end (== durationMs for photo)
            startMs: z.number(), // position on the 30s timeline (cumulative)
            durationMs: z.number(), // on-screen length of THIS segment
            transition: transitionEnum,
            overlay: overlayEnum.nullable().optional(),
          })
          .strict(),
      )
      .min(1),
    beatGrid: z.array(z.number()), // the track grid (ms) used for cut alignment
  })
  .strict();

export type Edl = z.infer<typeof edlSchema>;

// ── Runtime invariants (pure; usable by tests + worker) ───────────────────────

// Σ segments[].durationMs must be exactly the 30s timeline length.
export function edlDurationsSumTo30s(edl: Edl): boolean {
  return edl.segments.reduce((sum, s) => sum + s.durationMs, 0) === 30000;
}

// Every segment's startMs lands on/near SOME beat in the grid (±toleranceMs).
// The first segment (startMs === 0) is always allowed even if 0 isn't a beat.
export function edlCutsOnBeats(edl: Edl, toleranceMs = 60): boolean {
  return edl.segments.every((s, i) => {
    if (i === 0 && s.startMs === 0) return true;
    return edl.beatGrid.some((b) => Math.abs(b - s.startMs) <= toleranceMs);
  });
}
