#!/usr/bin/env node
// precompute-beatgrids.mjs — write a checked-in beat grid (ms onsets) for each
// bundled track, plus the music manifest the worker/API read by filesystem path.
//
// BEAT-DETECTION STRATEGY (M7 §3 / §11):
//   The milestone wants the essentia.js WASM path (DSP, no ML). We ATTEMPT it
//   first (guarded dynamic import). BUT the bundled tracks are SYNTHESIZED at an
//   EXACT known BPM (see gen-music.mjs), so a tempo-derived grid (beatMs = 60000/bpm)
//   is the GROUND TRUTH for them — more accurate than running a detector over a
//   synthetic signal, and free of WASM-in-CI fragility.
//
//   => For the synth placeholders we record `source:"tempo-derived"`.
//   => Real licensed/CC0 tracks (unknown tempo) would install essentia.js and run
//      the detector here; the EDL builder reads the same *.beatgrid.json either way,
//      so swapping in real tracks needs NO code change.
//
// Output: src/music/<id>.beatgrid.json + src/music/manifest.json
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACKS, DURATION_MS } from "./tracks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MUSIC_SRC_DIR = join(__dirname, "..", "src", "music");
const WAV_DIR = join(__dirname, "..", "public", "music");

// ---- Minimal 16-bit PCM WAV reader (only used on the essentia path) ----------
function readWavMono(path) {
  const buf = readFileSync(path);
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  // find 'data' chunk
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size;
  }
  if (dataOff < 0 || bits !== 16) throw new Error("unsupported wav");
  const samples = dataLen / 2;
  const out = new Float32Array(Math.floor(samples / channels));
  for (let i = 0, j = dataOff; i < out.length; i++, j += 2 * channels) {
    out[i] = buf.readInt16LE(j) / 32768;
  }
  return { data: out, sampleRate };
}

// ---- Tempo-derived grid: ground truth for the synth placeholders -------------
function tempoGrid(bpm) {
  const beatMs = 60000 / bpm;
  const grid = [];
  for (let t = 0; t < DURATION_MS; t += beatMs) grid.push(Math.round(t * 100) / 100);
  return grid;
}

// ---- Optional essentia.js detection (guarded; falls back if unavailable) -----
async function essentiaGrid(wavPath) {
  let mod;
  try {
    mod = await import("essentia.js");
  } catch {
    return null; // not installed → caller falls back
  }
  try {
    const EssentiaCtor = mod.Essentia ?? mod.default?.Essentia;
    const WASM = mod.EssentiaWASM ?? mod.default?.EssentiaWASM;
    if (!EssentiaCtor || !WASM) return null;
    const essentia = new EssentiaCtor(WASM.EssentiaWASM ?? WASM);
    const { data } = readWavMono(wavPath);
    const vec = essentia.arrayToVector(data);
    const r = essentia.RhythmExtractor2013(vec);
    const ticks = essentia.vectorToArray(r.ticks); // seconds
    const grid = Array.from(ticks)
      .map((s) => Math.round(s * 1000 * 100) / 100)
      .filter((ms) => ms < DURATION_MS);
    if (grid.length < 4) return null;
    return { grid, bpm: r.bpm };
  } catch (err) {
    console.warn(`  essentia.js ran but failed (${err?.message}); falling back.`);
    return null;
  }
}

async function main() {
  mkdirSync(MUSIC_SRC_DIR, { recursive: true });
  const manifest = [];

  for (const track of TRACKS) {
    const wavPath = join(WAV_DIR, `${track.id}.wav`);
    if (!existsSync(wavPath)) {
      console.warn(`  ! ${wavPath} missing — run gen-music.mjs first. Using tempo grid.`);
    }

    let grid;
    let source;
    let detectedBpm = track.bpm;

    const ess = existsSync(wavPath) ? await essentiaGrid(wavPath) : null;
    if (ess) {
      grid = ess.grid;
      detectedBpm = Math.round(ess.bpm);
      source = "essentia.js";
      console.log(`  ${track.id}: essentia.js → ${grid.length} beats (~${detectedBpm}bpm)`);
    } else {
      grid = tempoGrid(track.bpm);
      source = "tempo-derived";
      console.log(`  ${track.id}: tempo-derived → ${grid.length} beats @ ${track.bpm}bpm`);
    }

    const beatgrid = {
      musicId: track.id,
      bpm: detectedBpm,
      durationMs: DURATION_MS,
      // For synth placeholders this is exact; real tracks would carry essentia output.
      source,
      beatGrid: grid,
    };
    const beatgridFile = `src/music/${track.id}.beatgrid.json`;
    writeFileSync(
      join(MUSIC_SRC_DIR, `${track.id}.beatgrid.json`),
      JSON.stringify(beatgrid, null, 2) + "\n",
    );

    manifest.push({
      id: track.id,
      title: track.title,
      durationMs: DURATION_MS,
      bpm: track.bpm,
      file: `music/${track.id}.wav`,
      beatgridFile,
    });
  }

  writeFileSync(
    join(MUSIC_SRC_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`\nWrote ${manifest.length} beat grids + manifest.json to src/music/.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
