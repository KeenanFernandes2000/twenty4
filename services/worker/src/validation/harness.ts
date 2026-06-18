/**
 * §7.5 VALIDATION HARNESS — the render gate.
 *
 * Runs the FULL montage pipeline end-to-end on generated fixtures and asserts the
 * output meets the spec:
 *
 *   1. generate 50 mixed media items (photos + short videos) with ffmpeg;
 *   2. SCORE all 50 (motion/sharpness/brightness/face);
 *   3. pick a bundled synth track (exact beat grid — zero detection error);
 *   4. buildEdl → contracts-valid, beat-synced, gapless 30s EDL;
 *   5. serve media over HTTP (Chrome blocks file://) + build srcMap;
 *   6. getRenderer().render(edl, {srcMap, outDir}) → MP4;
 *   7. ffprobe + ASSERT: 1080×1920 / 30fps / 30.0s±0.2 / h264 / has-audio,
 *      every segment boundary within ±1 frame (~33ms) of a track beat, segments
 *      gapless & summing to 30000ms, render wall-clock within §10 (p95 <120s).
 *
 * It runs 3-5 VARIATIONS (different media mixes / themes / tracks), capping total
 * renders ≤5 to bound wall-clock, and summarizes PASS/FAIL + timings per variation.
 *
 * Also smoke-validates essentia.js loads & runs headless on a real track (the
 * primary beat-detection path), reporting which path is live.
 *
 * Run: `pnpm --filter @twenty4/worker run harness`  (after `source ~/.twenty4-dev-env.sh`)
 */
/* eslint-disable no-console */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Theme } from '@twenty4/contracts/enums';
import { getTrack, TRACKS } from '@twenty4/remotion/tracks';
import { buildEdl, scoreMany, smokeEssentia, type BuildItem } from '../intelligence/index.js';
import type { ScorableItem } from '../intelligence/index.js';
import { getRenderer } from '../render/index.js';
import {
  probe,
  probeRawText,
  startMediaServer,
  type MediaServer,
} from '../media/index.js';
import { generateFixturePool, type FixtureItem } from './fixtures.js';
import { EDL_DURATION_MS, EDL_FPS, type Edl } from '@twenty4/contracts/edl';

const FRAME_MS = 1000 / EDL_FPS; // ~33.33ms = ±1 frame tolerance
const REPO_MUSIC_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../infra/remotion/public/music',
);

interface Variation {
  name: string;
  musicId: string;
  theme: Theme;
  /** Fixture seed → different media mix per variation. */
  seed: number;
  /** Items in the pool (smaller pools for non-first variations bound wall-clock). */
  count: number;
}

interface VariationResult {
  name: string;
  pass: boolean;
  failures: string[];
  probe?: {
    width: number;
    height: number;
    fps: number;
    durationMs: number;
    videoCodec: string | null;
    audioCodec: string | null;
    hasAudio: boolean;
  };
  maxBeatErrorMs?: number;
  segmentCount?: number;
  renderWallMs?: number;
  rawProbe?: string;
  theme?: string;
  musicId?: string;
  beatSource?: string;
}

/* -------------------------------------------------------------------------- */
/*  EDL-level structural checks (cheap, no render)                              */
/* -------------------------------------------------------------------------- */

/** Max distance (ms) from each segment boundary to the nearest track beat. */
function maxBeatAlignmentError(edl: Edl): number {
  const grid = edl.beatGrid.beatsMs;
  const nearest = (t: number): number => {
    let best = Infinity;
    for (const b of grid) {
      const d = Math.abs(b - t);
      if (d < best) best = d;
    }
    return best;
  };
  let maxErr = 0;
  // boundaries = every segment start + the final end (30000).
  for (const seg of edl.segments) {
    maxErr = Math.max(maxErr, nearest(seg.startMs));
  }
  maxErr = Math.max(maxErr, nearest(EDL_DURATION_MS));
  return maxErr;
}

/** Assert segments are gapless and sum to exactly 30000ms. Returns failures. */
function checkGaplessExact(edl: Edl): string[] {
  const fails: string[] = [];
  const segs = [...edl.segments].sort((a, b) => a.index - b.index);
  let cursor = 0;
  for (const seg of segs) {
    if (seg.startMs !== cursor) {
      fails.push(
        `gap/overlap at segment ${seg.index}: startMs=${seg.startMs} expected ${cursor}`,
      );
    }
    cursor = seg.startMs + seg.durationMs;
  }
  if (cursor !== EDL_DURATION_MS) {
    fails.push(`segments sum to ${cursor}ms, expected exactly ${EDL_DURATION_MS}ms`);
  }
  return fails;
}

/* -------------------------------------------------------------------------- */
/*  one variation                                                               */
/* -------------------------------------------------------------------------- */

async function runVariation(v: Variation, outDir: string): Promise<VariationResult> {
  const res: VariationResult = {
    name: v.name,
    pass: false,
    failures: [],
    theme: v.theme,
    musicId: v.musicId,
  };

  console.log(`\n──────────────────────────────────────────────────────────`);
  console.log(`▶ Variation "${v.name}" — theme=${v.theme}, track=${v.musicId}, items=${v.count}, seed=${v.seed}`);

  // 1. fixtures -------------------------------------------------------------
  console.log(`  [1/6] generating ${v.count} mixed fixtures…`);
  const pool = await generateFixturePool({ count: v.count, seed: v.seed });
  const nPhoto = pool.items.filter((i) => i.mediaType === 'photo').length;
  const nVideo = pool.items.length - nPhoto;
  console.log(`        ${nPhoto} photos + ${nVideo} videos in ${pool.dir}`);

  let server: MediaServer | undefined;
  try {
    // 2. score --------------------------------------------------------------
    console.log(`  [2/6] scoring ${pool.items.length} items…`);
    const t0score = Date.now();
    const scorable: ScorableItem[] = pool.items.map((i) => ({
      mediaRef: i.mediaRef,
      mediaType: i.mediaType,
      filePath: i.filePath,
      sourceDurationMs: i.sourceDurationMs,
    }));
    const scores = await scoreMany(scorable);
    console.log(`        scored in ${((Date.now() - t0score) / 1000).toFixed(1)}s`);
    const top = [...scores].sort((a, b) => b.score - a.score).slice(0, 3);
    console.log(
      `        top scores: ${top
        .map((s) => `${s.mediaRef}=${s.score.toFixed(2)}`)
        .join(', ')}`,
    );

    // 3. track --------------------------------------------------------------
    const track = getTrack(v.musicId);
    console.log(`  [3/6] track ${track.id} — bpm=${track.bpm}, ${track.beatGridMs.length} beats (exact synth grid)`);

    // 4. buildEdl -----------------------------------------------------------
    console.log(`  [4/6] buildEdl…`);
    const buildItems: BuildItem[] = pool.items.map((i: FixtureItem) => {
      const score = scores.find((s) => s.mediaRef === i.mediaRef)!;
      return {
        mediaRef: i.mediaRef,
        mediaType: i.mediaType,
        sourceDurationMs: i.sourceDurationMs,
        score,
      };
    });
    const edl = buildEdl({
      items: buildItems,
      track: {
        musicId: track.id,
        bpm: track.bpm,
        beatGridMs: track.beatGridMs,
        dropsMs: track.dropsMs,
      },
      theme: v.theme,
    });
    res.segmentCount = edl.segments.length;
    console.log(
      `        EDL: ${edl.segments.length} segments, resolved theme=${edl.themeStyle.theme}`,
    );

    // EDL-level structural assertions (before paying for a render).
    const gaplessFails = checkGaplessExact(edl);
    res.failures.push(...gaplessFails);
    const beatErr = maxBeatAlignmentError(edl);
    res.maxBeatErrorMs = beatErr;
    if (beatErr > FRAME_MS) {
      res.failures.push(
        `beat-alignment: max boundary error ${beatErr.toFixed(1)}ms > ±1 frame (${FRAME_MS.toFixed(1)}ms)`,
      );
    }

    // 5. serve media + srcMap ----------------------------------------------
    console.log(`  [5/6] serving media + rendering…`);
    server = await startMediaServer(pool.dir);
    const srcMap: Record<string, string> = {};
    for (const i of pool.items) srcMap[i.mediaRef] = server.url(i.mediaRef);

    // 6. render -------------------------------------------------------------
    const renderer = getRenderer();
    const t0 = Date.now();
    const result = await renderer.render(edl, {
      srcMap,
      outDir,
      outBasename: `gate-${v.name}`,
      onProgress: (p) => {
        const pct = Math.round(p * 100);
        if (pct % 25 === 0) process.stdout.write(`\r        render ${pct}%   `);
      },
    });
    res.renderWallMs = Date.now() - t0;
    process.stdout.write('\n');
    console.log(`        rendered in ${(res.renderWallMs / 1000).toFixed(1)}s → ${result.videoPath}`);

    // ffprobe + assert ------------------------------------------------------
    const p = await probe(result.videoPath);
    res.rawProbe = await probeRawText(result.videoPath);
    res.probe = {
      width: p.width,
      height: p.height,
      fps: detectFps(p.raw),
      durationMs: p.durationMs,
      videoCodec: p.videoCodec,
      audioCodec: p.audioCodec,
      hasAudio: p.hasAudio,
    };

    if (p.width !== 1080) res.failures.push(`width ${p.width} ≠ 1080`);
    if (p.height !== 1920) res.failures.push(`height ${p.height} ≠ 1920`);
    if (res.probe.fps !== 30)
      res.failures.push(`fps ${res.probe.fps} ≠ 30`);
    if (p.videoCodec !== 'h264')
      res.failures.push(`video codec ${p.videoCodec} ≠ h264`);
    if (!p.hasAudio) res.failures.push(`no audio track`);
    if (Math.abs(p.durationMs - 30000) > 200)
      res.failures.push(
        `duration ${(p.durationMs / 1000).toFixed(3)}s outside 30.0±0.2`,
      );
    if (res.renderWallMs > 120_000)
      res.failures.push(
        `render ${(res.renderWallMs / 1000).toFixed(1)}s > p95 budget 120s (§10)`,
      );

    res.pass = res.failures.length === 0;
  } catch (err) {
    res.failures.push(`exception: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
  } finally {
    if (server) await server.close();
    await pool.cleanup();
  }

  // per-variation summary
  if (res.pass) {
    console.log(
      `  ✅ PASS — ${res.probe!.width}×${res.probe!.height} @${res.probe!.fps}fps, ` +
        `${(res.probe!.durationMs / 1000).toFixed(2)}s, ${res.probe!.videoCodec}+${res.probe!.audioCodec}, ` +
        `beatErr≤${res.maxBeatErrorMs!.toFixed(1)}ms, ${(res.renderWallMs! / 1000).toFixed(1)}s`,
    );
  } else {
    console.log(`  ❌ FAIL`);
    for (const f of res.failures) console.log(`       - ${f}`);
  }
  return res;
}

/** Pull an integer fps from ffprobe's r_frame_rate (e.g. "30/1"). */
function detectFps(raw: unknown): number {
  const j = raw as { streams?: { codec_type?: string; r_frame_rate?: string; avg_frame_rate?: string }[] };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  const rate = v?.avg_frame_rate ?? v?.r_frame_rate ?? '0/1';
  const [num, den] = rate.split('/').map((x) => parseInt(x, 10));
  if (!num || !den) return 0;
  return Math.round(num / den);
}

/* -------------------------------------------------------------------------- */
/*  main                                                                        */
/* -------------------------------------------------------------------------- */

/** The variations the gate runs. Capped to ≤5 renders to bound wall-clock. */
export const GATE_VARIATIONS: Variation[] = [
  { name: 'party-50', musicId: 'house_120', theme: 'Party', seed: 1, count: 50 },
  { name: 'fastcut-mix', musicId: 'fastcut_128', theme: 'Fast Cut', seed: 7, count: 30 },
  { name: 'chill-mellow', musicId: 'chill_90', theme: 'Mellow', seed: 13, count: 24 },
  { name: 'clean-random', musicId: 'clean_100', theme: 'Random', seed: 21, count: 20 },
];

/** Run the gate. `quick` runs ONE variation (used by the vitest test). */
export async function runGate(opts: { quick?: boolean; outDir?: string } = {}): Promise<{
  pass: boolean;
  results: VariationResult[];
  essentia: { ok: boolean; detail: string; source: string };
}> {
  const outDir = opts.outDir ?? path.join(process.cwd(), '.gate-out');
  await mkdir(outDir, { recursive: true });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  twenty4 §7.5 VALIDATION HARNESS — render gate');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  FFMPEG_PATH=${process.env.FFMPEG_PATH ?? '(default)'}`);
  console.log(`  output dir=${outDir}`);
  console.log(`  available tracks: ${Object.keys(TRACKS).join(', ')}`);

  // essentia.js smoke (primary beat-detection path) ------------------------
  const essentia = { ok: false, detail: '', source: 'precomputed (exact synth grid)' };
  try {
    const trackFile = path.join(REPO_MUSIC_DIR, getTrack('house_120').file.replace('music/', ''));
    console.log(`\n  smoke: essentia.js on ${path.basename(trackFile)}…`);
    const r = await smokeEssentia(trackFile);
    essentia.ok = true;
    essentia.detail = `essentia.js v${r.version} OK — detected ${r.bpm.toFixed(2)} BPM, ${r.beats} beats`;
    essentia.source = 'essentia.js (live) — gate uses exact synth grids for determinism';
    console.log(`  ✓ ${essentia.detail}`);
  } catch (err) {
    essentia.detail = `essentia.js failed to load/run: ${err instanceof Error ? err.message : String(err)} — PCM onset fallback would be used for real audio`;
    console.log(`  ⚠ ${essentia.detail}`);
  }

  const variations = opts.quick ? GATE_VARIATIONS.slice(0, 1) : GATE_VARIATIONS;
  const results: VariationResult[] = [];
  try {
    for (const v of variations) {
      results.push(await runVariation(v, outDir));
    }
  } finally {
    // Release the shared headless browser the renderer keeps across renders.
    await getRenderer().close?.();
  }

  // summary -----------------------------------------------------------------
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  GATE SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  const wallTimes = results.map((r) => r.renderWallMs ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
  for (const r of results) {
    const p = r.probe;
    console.log(
      `  ${r.pass ? '✅ PASS' : '❌ FAIL'}  ${r.name.padEnd(14)} ` +
        (p
          ? `${p.width}×${p.height} @${p.fps}fps ${(p.durationMs / 1000).toFixed(2)}s ` +
            `${p.videoCodec}+${p.audioCodec ?? 'noaudio'} | beatErr≤${(r.maxBeatErrorMs ?? 0).toFixed(1)}ms | ` +
            `${r.segmentCount}segs | ${((r.renderWallMs ?? 0) / 1000).toFixed(1)}s`
          : '(no render)'),
    );
    if (!r.pass) for (const f of r.failures) console.log(`           ↳ ${f}`);
  }
  if (wallTimes.length) {
    const p95 = wallTimes[Math.min(wallTimes.length - 1, Math.ceil(wallTimes.length * 0.95) - 1)]!;
    const p50 = wallTimes[Math.floor(wallTimes.length / 2)]!;
    console.log(
      `\n  §10 render timing: p50=${(p50 / 1000).toFixed(1)}s, p95=${(p95 / 1000).toFixed(1)}s ` +
        `(targets: p50<60s, p95<120s) — ${p95 < 120_000 ? 'WITHIN BUDGET ✓' : 'OVER ✗'}`,
    );
  }
  console.log(`  beat-detection: ${essentia.source}`);

  const pass = results.length > 0 && results.every((r) => r.pass);
  console.log(
    `\n  ${pass ? '✅ GATE PASSED' : '❌ GATE FAILED'} — ${results.filter((r) => r.pass).length}/${results.length} variations passed`,
  );
  return { pass, results, essentia };
}

/* run as a script (the `harness` pnpm script) */
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  runGate()
    .then(({ pass }) => {
      // dump one raw ffprobe for evidence
      process.exit(pass ? 0 : 1);
    })
    .catch((err) => {
      console.error('\n❌ HARNESS CRASHED');
      console.error(err);
      process.exit(1);
    });
}
