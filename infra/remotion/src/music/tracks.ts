/**
 * Bundled music registry — `musicId → { file, bpm, beatGridMs, ... }`.
 *
 * The intelligence layer (`@twenty4/worker` intelligence, added later) reads a
 * track's `beatGridMs` to align cuts; the renderer reads `file` to load the audio
 * via `staticFile()`. The EDL carries its OWN `beatGrid` (the analysis snapshot
 * used to build that specific cut), but these registry grids are the canonical
 * source the intelligence derives the EDL grid from.
 *
 * STATUS of the bundled tracks (§13 business unknown — music source TBD):
 *   ALL FOUR are SYNTHESIZED (a tonal bed + an exact per-beat kick), NOT licensed.
 *   Because the kick is generated on a mathematically exact grid, `beatGridMs` is
 *   EXACT (no detection error) — perfect for the deterministic render gate.
 *   // TODO(music): replace each with a licensed/CC0 track + essentia.js beat grid.
 *
 * The registry is structured to grow to ~15 tracks; add entries + a generated
 * file under `public/music/` and the renderer picks them up with no code change.
 */
import type { ConcreteTheme } from '@twenty4/contracts/enums';

export interface BundledTrack {
  /** Stable id referenced by `EdlAudio.musicId`. */
  id: string;
  /** Filename under `public/music/` (resolved via Remotion `staticFile`). */
  file: string;
  /** Human label (UI music picker, screen 2.7). */
  title: string;
  /** Beats per minute (exact for synthesized tracks). */
  bpm: number;
  /** Track length in ms (all bundled tracks are >= 30s + headroom). */
  durationMs: number;
  /** Exact beat onset times (ms) from 0 to end of track. */
  beatGridMs: number[];
  /** Higher-energy "drop"/accent markers that bias faster cuts (§7.1 step 3). */
  dropsMs: number[];
  /** Themes this track pairs well with (selection hint for the intelligence). */
  themes: ConcreteTheme[];
  /** True = synthesized placeholder; false = real licensed/CC0 track. */
  synthesized: boolean;
}

/** Build an exact beat grid (ms) covering [0, durationMs] for a given BPM. */
function buildBeatGrid(bpm: number, durationMs: number): number[] {
  const periodMs = 60_000 / bpm;
  const beats: number[] = [];
  for (let t = 0; t <= durationMs + 1e-6; t += periodMs) {
    beats.push(Math.round(t));
  }
  return beats;
}

/** Drop markers every `everyNBeats` beats (phrase boundaries) — bias faster cuts. */
function dropsEvery(beatGridMs: number[], everyNBeats: number): number[] {
  const out: number[] = [];
  for (let i = everyNBeats; i < beatGridMs.length; i += everyNBeats) {
    out.push(beatGridMs[i]!);
  }
  return out;
}

const DURATION_MS = 36_000;

function makeTrack(
  spec: Omit<BundledTrack, 'durationMs' | 'beatGridMs' | 'dropsMs'> & {
    dropEveryNBeats: number;
  },
): BundledTrack {
  const beatGridMs = buildBeatGrid(spec.bpm, DURATION_MS);
  return {
    id: spec.id,
    file: spec.file,
    title: spec.title,
    bpm: spec.bpm,
    durationMs: DURATION_MS,
    beatGridMs,
    dropsMs: dropsEvery(beatGridMs, spec.dropEveryNBeats),
    themes: spec.themes,
    synthesized: spec.synthesized,
  };
}

export const TRACKS: Record<string, BundledTrack> = {
  chill_90: makeTrack({
    id: 'chill_90',
    file: 'music/chill_90.mp3',
    title: 'Chill 90 (synth)',
    bpm: 90,
    dropEveryNBeats: 8,
    themes: ['Chill', 'Mellow', 'Soft'],
    synthesized: true,
  }),
  house_120: makeTrack({
    id: 'house_120',
    file: 'music/house_120.mp3',
    title: 'House 120 (synth)',
    bpm: 120,
    dropEveryNBeats: 8,
    themes: ['Party', 'Travel'],
    synthesized: true,
  }),
  fastcut_128: makeTrack({
    id: 'fastcut_128',
    file: 'music/fastcut_128.mp3',
    title: 'Fast Cut 128 (synth)',
    bpm: 128,
    dropEveryNBeats: 4,
    themes: ['Fast Cut', 'Party'],
    synthesized: true,
  }),
  clean_100: makeTrack({
    id: 'clean_100',
    file: 'music/clean_100.mp3',
    title: 'Clean 100 (synth)',
    bpm: 100,
    dropEveryNBeats: 8,
    themes: ['Clean', 'Soft'],
    synthesized: true,
  }),
};

/** Resolve a musicId to its bundled track, or throw (renderer fails loudly). */
export function getTrack(musicId: string): BundledTrack {
  const t = TRACKS[musicId];
  if (!t) {
    throw new Error(
      `Unknown musicId "${musicId}". Known: ${Object.keys(TRACKS).join(', ')}`,
    );
  }
  return t;
}

/** All track ids (for the music picker / harness). */
export const TRACK_IDS = Object.keys(TRACKS);
