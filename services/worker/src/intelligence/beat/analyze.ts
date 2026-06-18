/**
 * Beat grid analysis (§7.1 step 1).
 *
 * Produces `{ bpm, beatsMs[] }` for a piece of audio. Two paths:
 *
 *   1. PRIMARY — essentia.js `RhythmExtractor2013` (WASM, headless-safe). We
 *      ffmpeg-decode the audio to mono f32 PCM, hand it to essentia, and read
 *      `bpm` + per-beat `ticks` (seconds → ms). This is what runs on
 *      USER-SUPPLIED / real tracks.
 *   2. FALLBACK — a self-contained energy-onset detector over the decoded PCM
 *      (spectral-flux-free, amplitude-envelope peaks → tempo), used only if
 *      essentia.js fails to load/run. No extra native deps.
 *
 * For the BUNDLED SYNTH tracks the beat grid is mathematically EXACT (the kick is
 * generated on a perfect grid), so `analyzeTrack()` prefers the precomputed
 * `track.beatGridMs` (a cache) — real detection is reserved for arbitrary audio.
 * The render gate therefore aligns cuts to a zero-error grid while STILL proving
 * essentia.js loads & runs headless (smoke in `harness` / `smokeEssentia()`).
 *
 * Exposes `analyzeBeats(audioPath) -> { bpm, beatsMs[], source }`.
 */
import { execa } from 'execa';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';
const SAMPLE_RATE = 44_100;

export type BeatSource = 'essentia' | 'pcm-onset' | 'precomputed';

export interface BeatGridResult {
  bpm: number;
  /** Ordered beat onset times in ms from the start of the audio. */
  beatsMs: number[];
  /** Which detection path produced this grid (reported by the gate). */
  source: BeatSource;
}

/* -------------------------------------------------------------------------- */
/*  ffmpeg PCM decode                                                          */
/* -------------------------------------------------------------------------- */

/** Decode any audio file to mono float32 PCM @ 44.1kHz via ffmpeg. */
export async function decodePcm(audioPath: string): Promise<Float32Array> {
  const dir = await mkdtemp(path.join(tmpdir(), 'twenty4-pcm-'));
  const out = path.join(dir, 'audio.f32');
  try {
    await execa(FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      audioPath,
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      out,
    ]);
    const buf = await readFile(out);
    // Copy into a standalone Float32Array (detach from the file Buffer's pool).
    const view = new Float32Array(
      buf.buffer,
      buf.byteOffset,
      Math.floor(buf.byteLength / 4),
    );
    return Float32Array.from(view);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/*  essentia.js (primary)                                                       */
/* -------------------------------------------------------------------------- */

interface EssentiaLike {
  version?: string;
  arrayToVector(arr: Float32Array): unknown;
  vectorToArray(v: unknown): Float32Array;
  RhythmExtractor2013(
    signal: unknown,
    maxTempo?: number,
    method?: string,
    minTempo?: number,
  ): { bpm: number; ticks: unknown; confidence: number };
  delete?(): void;
}

let essentiaSingleton: EssentiaLike | null = null;

/** Lazily construct a single essentia instance (WASM init is not free). */
async function getEssentia(): Promise<EssentiaLike> {
  if (essentiaSingleton) return essentiaSingleton;
  const mod = (await import('essentia.js')) as unknown as {
    Essentia: new (wasm: unknown) => EssentiaLike;
    EssentiaWASM: unknown;
  };
  // essentia.js exports the wasm module either directly or nested under
  // `.EssentiaWASM` depending on the build; handle both.
  const wasm =
    (mod.EssentiaWASM as { EssentiaWASM?: unknown }).EssentiaWASM ??
    mod.EssentiaWASM;
  essentiaSingleton = new mod.Essentia(wasm);
  return essentiaSingleton;
}

/**
 * Smoke-validate essentia.js loads & runs on a real audio file. Returns the
 * detected bpm + version on success, or throws. The harness calls this once to
 * REPORT which beat-detection path is live (§ deliverable).
 */
export async function smokeEssentia(
  audioPath: string,
): Promise<{ ok: true; bpm: number; version: string; beats: number }> {
  const pcm = await decodePcm(audioPath);
  const ess = await getEssentia();
  const vec = ess.arrayToVector(pcm);
  const r = ess.RhythmExtractor2013(vec);
  const ticks = ess.vectorToArray(r.ticks);
  return {
    ok: true,
    bpm: r.bpm,
    version: ess.version ?? 'unknown',
    beats: ticks.length,
  };
}

/** essentia.js beat detection over decoded PCM. */
async function analyzeEssentia(pcm: Float32Array): Promise<BeatGridResult> {
  const ess = await getEssentia();
  const vec = ess.arrayToVector(pcm);
  const r = ess.RhythmExtractor2013(vec);
  const ticks = Array.from(ess.vectorToArray(r.ticks));
  if (!ticks.length || !isFinite(r.bpm) || r.bpm <= 0) {
    throw new Error('essentia returned an empty/invalid beat grid');
  }
  return {
    bpm: r.bpm,
    beatsMs: ticks.map((s) => Math.round(s * 1000)),
    source: 'essentia',
  };
}

/* -------------------------------------------------------------------------- */
/*  PCM onset fallback (no native deps)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Amplitude-envelope onset detector → tempo + beat grid. Self-contained; only
 * used when essentia.js can't load. Steps:
 *   1. RMS energy envelope over ~10ms hops.
 *   2. Positive first-difference (energy increases) = onset strength.
 *   3. Pick peaks above a moving threshold → onset times.
 *   4. Median inter-onset interval → BPM; synthesize a regular grid phase-locked
 *      to the first strong onset (musical beats are near-periodic).
 */
function analyzePcmOnset(pcm: Float32Array): BeatGridResult {
  const hop = Math.round(SAMPLE_RATE * 0.01); // 10ms
  const win = hop * 2;
  const nFrames = Math.floor((pcm.length - win) / hop);

  // 1. RMS envelope
  const env = new Float32Array(Math.max(0, nFrames));
  for (let i = 0; i < nFrames; i++) {
    let sum = 0;
    const start = i * hop;
    for (let j = 0; j < win; j++) {
      const s = pcm[start + j] ?? 0;
      sum += s * s;
    }
    env[i] = Math.sqrt(sum / win);
  }

  // 2. positive flux
  const flux = new Float32Array(env.length);
  for (let i = 1; i < env.length; i++) {
    const d = env[i]! - env[i - 1]!;
    flux[i] = d > 0 ? d : 0;
  }

  // 3. adaptive peak picking
  const onsets: number[] = [];
  const W = 20; // ~200ms half-window for the local mean
  for (let i = 1; i < flux.length - 1; i++) {
    const lo = Math.max(0, i - W);
    const hi = Math.min(flux.length, i + W);
    let mean = 0;
    for (let k = lo; k < hi; k++) mean += flux[k]!;
    mean /= hi - lo;
    const thresh = mean * 1.5 + 1e-6;
    if (flux[i]! > thresh && flux[i]! >= flux[i - 1]! && flux[i]! >= flux[i + 1]!) {
      const last = onsets[onsets.length - 1];
      const tMs = (i * hop * 1000) / SAMPLE_RATE;
      // refractory ~120ms (max ~500 BPM) to avoid double-triggering
      if (last === undefined || tMs - last > 120) onsets.push(tMs);
    }
  }

  // 4. median inter-onset → BPM; fall back to 120 if too few onsets
  let bpm = 120;
  if (onsets.length >= 4) {
    const iois: number[] = [];
    for (let i = 1; i < onsets.length; i++) iois.push(onsets[i]! - onsets[i - 1]!);
    iois.sort((a, b) => a - b);
    let medianIoi = iois[Math.floor(iois.length / 2)]!;
    // Fold into a musical range (60..180 BPM).
    while (60_000 / medianIoi > 180) medianIoi *= 2;
    while (60_000 / medianIoi < 60) medianIoi /= 2;
    bpm = 60_000 / medianIoi;
  }

  // synthesize a regular grid phase-locked to the first onset
  const period = 60_000 / bpm;
  const phase = onsets[0] ?? 0;
  const durMs = (pcm.length * 1000) / SAMPLE_RATE;
  const beatsMs: number[] = [];
  for (let t = phase; t <= durMs + 1e-6; t += period) beatsMs.push(Math.round(t));
  // include a beat at 0 if the phase pushed the grid start forward
  if (beatsMs[0]! > period / 2) beatsMs.unshift(0);

  return { bpm, beatsMs, source: 'pcm-onset' };
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Analyze an audio FILE → beat grid. Tries essentia.js first, falls back to the
 * PCM onset detector. For bundled synth tracks, prefer the exact precomputed
 * grid via `analyzeTrack()` instead.
 */
export async function analyzeBeats(audioPath: string): Promise<BeatGridResult> {
  const pcm = await decodePcm(audioPath);
  try {
    return await analyzeEssentia(pcm);
  } catch (err) {
    // Documented fallback — report which path won at the call site.
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[beat] essentia.js path failed (${reason}); using PCM onset fallback\n`,
    );
    return analyzePcmOnset(pcm);
  }
}
