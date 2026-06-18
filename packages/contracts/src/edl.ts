/**
 * EDL — Edit Decision List (§7.1).
 *
 * THE INTELLIGENCE ↔ RENDERER SEAM. The montage intelligence (algorithmic,
 * beat-synced) EMITS this; the Remotion `<Montage/>` composition CONSUMES it as
 * inputProps and produces the 9:16 / 30s / 30fps MP4. The renderer makes NO
 * creative decisions — every cut, trim, transition, and overlay is decided here.
 *
 * Keep this precise and self-documenting: it is the contract that lets the
 * intelligence and the renderer evolve independently (and lets step-2 heuristics
 * be swapped for an ML model later with ZERO renderer change, §7.1 "dial").
 *
 * Spec sketch (§7.1):
 *   EditDecisionList {
 *     durationMs: 30000, aspect: "9:16", musicId,
 *     segments: [ { mediaRef, inMs, outMs, transition, overlay? }, ... ]
 *   }
 * This schema is a superset: it adds the fields a real renderer needs (timeline
 * placement, fps/canvas, beat grid, per-theme styling). All times are in ms.
 */
import { z } from 'zod';
import { concreteThemeSchema, mediaTypeSchema } from './enums.js';

/* -------------------------------------------------------------------------- */
/*  Canvas / output constants (§10 output: 9:16, 30s, 30fps)                    */
/* -------------------------------------------------------------------------- */

export const EDL_WIDTH = 1080 as const;
export const EDL_HEIGHT = 1920 as const;
export const EDL_FPS = 30 as const;
export const EDL_DURATION_MS = 30_000 as const;
export const EDL_ASPECT = '9:16' as const;

/* -------------------------------------------------------------------------- */
/*  Transitions & overlays                                                      */
/* -------------------------------------------------------------------------- */

/** Transition styles a theme may select between segments. */
export const TRANSITION_TYPES = [
  'cut', // hard cut on the beat (default for Fast Cut / Party)
  'crossfade',
  'fade_through_black',
  'whip_pan', // fast directional blur (Fast Cut)
  'zoom_blur',
  'dissolve', // soft (Soft / Mellow)
] as const;
export const transitionTypeSchema = z.enum(TRANSITION_TYPES);
export type TransitionType = z.infer<typeof transitionTypeSchema>;

/** A transition at a segment boundary. `durationMs` 0 ⇒ instantaneous (cut). */
export const transitionSchema = z
  .object({
    type: transitionTypeSchema,
    /** Length of the transition; 0 for a hard cut. Beat-aligned by the intelligence. */
    durationMs: z.number().int().min(0).max(2000),
  })
  .strict();
export type Transition = z.infer<typeof transitionSchema>;

/** Overlay / effect treatments a theme can apply on top of a segment. */
export const OVERLAY_TYPES = [
  'none',
  'date_stamp', // small "today" date chip
  'caption', // short non-PII text label (e.g. theme name) — NEVER user content here
  'grain', // film grain (Soft / Mellow)
  'light_leak', // (Travel / Chill)
  'vignette',
  'flash', // beat-synced flash (Party)
  'speed_ramp', // visual speed indicator
] as const;
export const overlayTypeSchema = z.enum(OVERLAY_TYPES);
export type OverlayType = z.infer<typeof overlayTypeSchema>;

export const overlaySchema = z
  .object({
    type: overlayTypeSchema,
    /**
     * Optional static text for `caption`/`date_stamp` overlays. This is theme/
     * date chrome ONLY — never user-authored content. // TODO(spec-gap): keep
     * text generation server-side & non-PII.
     */
    text: z.string().max(40).optional(),
    /** 0..1 strength for grain/vignette/leak. */
    intensity: z.number().min(0).max(1).optional(),
  })
  .strict();
export type Overlay = z.infer<typeof overlaySchema>;

/* -------------------------------------------------------------------------- */
/*  Segment                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One clip/photo placed on the 30s timeline.
 *
 *  - source trim:    `inMs`/`outMs` index INTO the source media (for photos these
 *                    are 0/holdDuration — the renderer holds a still).
 *  - timeline place: `startMs` + `durationMs` index INTO the output timeline.
 *                    `durationMs === outMs - inMs` for video at 1x speed; photos
 *                    use `durationMs` as the hold length. All beat-aligned.
 */
export const edlSegmentSchema = z
  .object({
    /** Stable index in the EDL ordering (0-based). */
    index: z.number().int().min(0),
    /** S3 storage key of the source `daily_media_item` (no public URL). */
    mediaRef: z.string().min(1),
    mediaType: mediaTypeSchema,

    // --- source trim (into the media) ---
    /** Start offset into the source clip; 0 for photos. */
    inMs: z.number().int().min(0),
    /** End offset into the source clip; = inMs + hold for photos. */
    outMs: z.number().int().min(0),

    // --- timeline placement (into the 30s output) ---
    /** When this segment starts on the output timeline (beat-aligned). */
    startMs: z.number().int().min(0).max(EDL_DURATION_MS),
    /** How long it occupies the output timeline (beat-aligned). */
    durationMs: z.number().int().min(1).max(EDL_DURATION_MS),

    /** Playback speed multiplier (1 = realtime; >1 for fast-cut energy sections). */
    speed: z.number().positive().default(1),

    /** Transition INTO this segment (from the previous). */
    transitionIn: transitionSchema.optional(),
    /** Transition OUT of this segment (into the next). */
    transitionOut: transitionSchema.optional(),

    /** Overlay/effect applied to this segment (per theme). */
    overlay: overlaySchema.optional(),

    /** The intelligence's per-clip quality score (0..1) — diagnostic, renderer ignores. */
    score: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((s) => s.outMs >= s.inMs, {
    message: 'segment outMs must be >= inMs',
    path: ['outMs'],
  });
export type EdlSegment = z.infer<typeof edlSegmentSchema>;

/* -------------------------------------------------------------------------- */
/*  Beat grid & per-theme styling                                               */
/* -------------------------------------------------------------------------- */

/** Beat grid from track analysis (§7.1 step 1) — cuts land on these times. */
export const beatGridSchema = z
  .object({
    bpm: z.number().positive(),
    /** Ordered beat onset times (ms) within the 30s window the cuts align to. */
    beatsMs: z.array(z.number().int().min(0)),
    /** Optional higher-energy "drop" markers that bias faster cuts (§7.1 step 3). */
    dropsMs: z.array(z.number().int().min(0)).optional(),
  })
  .strict();
export type BeatGrid = z.infer<typeof beatGridSchema>;

/**
 * Per-theme styling props the renderer reads (§7.1 step 4). The intelligence
 * resolves a `Random` request to a concrete theme before emitting.
 */
export const themeStyleSchema = z
  .object({
    theme: concreteThemeSchema,
    /** Default transition the theme prefers between cuts. */
    defaultTransition: transitionTypeSchema,
    /** Bias for cut density: >1 favours more/shorter cuts (Fast Cut/Party). */
    cutDensityBias: z.number().positive().default(1),
    /** Color grade / LUT identifier the renderer applies (bundled with the comp). */
    colorGrade: z.string().optional(),
    /** Default overlay treatment for the theme. */
    overlay: overlaySchema.optional(),
  })
  .strict();
export type ThemeStyle = z.infer<typeof themeStyleSchema>;

/* -------------------------------------------------------------------------- */
/*  Audio                                                                        */
/* -------------------------------------------------------------------------- */

export const edlAudioSchema = z
  .object({
    /** Bundled track id (resolved to a file by the renderer's music map). */
    musicId: z.string().min(1),
    /** Offset into the track to start from (ms) — pick a strong section. */
    startMs: z.number().int().min(0).default(0),
    /** 0..1 master music volume. */
    volume: z.number().min(0).max(1).default(1),
  })
  .strict();
export type EdlAudio = z.infer<typeof edlAudioSchema>;

/* -------------------------------------------------------------------------- */
/*  EDL (top level)                                                              */
/* -------------------------------------------------------------------------- */

export const edlSchema = z
  .object({
    /** Schema version for forward-compat between intelligence & renderer. */
    version: z.literal(1).default(1),

    // Canvas / output (fixed for the prototype; explicit so the renderer is self-describing).
    width: z.literal(EDL_WIDTH).default(EDL_WIDTH),
    height: z.literal(EDL_HEIGHT).default(EDL_HEIGHT),
    fps: z.literal(EDL_FPS).default(EDL_FPS),
    aspect: z.literal(EDL_ASPECT).default(EDL_ASPECT),
    durationMs: z.literal(EDL_DURATION_MS).default(EDL_DURATION_MS),

    audio: edlAudioSchema,
    beatGrid: beatGridSchema,
    themeStyle: themeStyleSchema,

    /** Ordered segments filling the 30s timeline (beat-aligned, gapless). */
    segments: z.array(edlSegmentSchema).min(1),
  })
  .strict();

/** The EDL the intelligence emits and Remotion reads. */
export type Edl = z.infer<typeof edlSchema>;
