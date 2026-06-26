#!/usr/bin/env node
// gen-music.mjs — synthesize 4 PLACEHOLDER music tracks (CC0-equivalent, fully
// generated here, no third-party audio). Each is ~30s, mono, 22.05kHz, 16-bit PCM
// WAV with a simple kick + hat + bass + lead pattern at a distinct tempo/mood.
//
// These are the §11 "placeholder synth" tracks. Real licensed/CC0 music swaps in
// without code change (drop a <id>.wav in public/music and re-run precompute-beatgrids).
//
// Output: infra/remotion/public/music/<id>.wav
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACKS, DURATION_MS } from "./tracks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public", "music");

const SAMPLE_RATE = 22050;
const DURATION_S = DURATION_MS / 1000;
const N = SAMPLE_RATE * DURATION_S;

const midi = (root, semis) => root * Math.pow(2, semis / 12);

// Simple deterministic PRNG so generated noise is reproducible across runs.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synth(track) {
  const buf = new Float32Array(N);
  const rand = mulberry32(0xc0ffee ^ track.bpm);
  const beatS = 60 / track.bpm;
  const beatSamples = beatS * SAMPLE_RATE;
  const totalBeats = Math.ceil(DURATION_S / beatS);

  // A short low-pass-ish state for the hat noise to avoid pure white harshness.
  for (let b = 0; b < totalBeats; b++) {
    const beatStart = Math.floor(b * beatSamples);

    // --- Kick: 60Hz sine with a downward pitch sweep + exp amp decay (~260ms)
    const kickLen = Math.floor(0.26 * SAMPLE_RATE);
    for (let i = 0; i < kickLen && beatStart + i < N; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.exp(-t * 18);
      const pitch = 110 * Math.exp(-t * 30) + 48; // sweep 158Hz -> 48Hz
      buf[beatStart + i] += Math.sin(2 * Math.PI * pitch * t) * env * 0.85;
    }

    // --- Hats: on each 8th note (twice per beat), short noise burst.
    for (let h = 0; h < 2; h++) {
      const hatStart = Math.floor((b + h * 0.5) * beatSamples);
      const hatLen = Math.floor(0.045 * SAMPLE_RATE);
      let last = 0;
      for (let i = 0; i < hatLen && hatStart + i < N; i++) {
        const t = i / SAMPLE_RATE;
        const env = Math.exp(-t * 80);
        const white = rand() * 2 - 1;
        last = 0.6 * white + 0.4 * last; // gentle smoothing
        const accent = h === 0 ? 1 : 0.65;
        buf[hatStart + i] += last * env * track.hatGain * accent;
      }
    }

    // --- Bass: root-ish note held for the beat (sine), drives the groove.
    const bassNote = track.scale[b % 2 === 0 ? 0 : 2 % track.scale.length];
    const bassFreq = midi(track.root, bassNote) / 2; // one octave down
    const bassLen = Math.floor(beatSamples * 0.95);
    for (let i = 0; i < bassLen && beatStart + i < N; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.min(1, t * 40) * Math.exp(-t * 1.6);
      buf[beatStart + i] += Math.sin(2 * Math.PI * bassFreq * t) * env * 0.2;
    }

    // --- Lead: a pentatonic/scale arpeggio note per beat (triangle-ish).
    const noteSemis = track.scale[(b * 3) % track.scale.length];
    const leadFreq = midi(track.root, noteSemis);
    const leadLen = Math.floor(beatSamples * 0.6);
    for (let i = 0; i < leadLen && beatStart + i < N; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.min(1, t * 60) * Math.exp(-t * 3.5);
      // triangle from sine harmonics (cheap, soft)
      const ph = 2 * Math.PI * leadFreq * t;
      const tri = Math.sin(ph) - 0.18 * Math.sin(3 * ph) + 0.06 * Math.sin(5 * ph);
      buf[beatStart + i] += tri * env * track.leadGain;
    }
  }

  // Master: short fade-in/out + peak normalize to 0.9 to prevent clipping.
  const fade = Math.floor(0.05 * SAMPLE_RATE);
  let peak = 0;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const norm = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < N; i++) {
    let v = buf[i] * norm;
    if (i < fade) v *= i / fade;
    if (i > N - fade) v *= (N - i) / fade;
    buf[i] = v;
  }
  return buf;
}

function encodeWav(float32) {
  const bytesPerSample = 2;
  const dataSize = float32.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  // RIFF header
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  // fmt chunk
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  let off = 44;
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    buffer.writeInt16LE(Math.round(s * 32767), off);
    off += bytesPerSample;
  }
  return buffer;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const track of TRACKS) {
    const pcm = synth(track);
    const wav = encodeWav(pcm);
    const out = join(OUT_DIR, `${track.id}.wav`);
    writeFileSync(out, wav);
    console.log(
      `wrote ${out} (${track.bpm}bpm, ${(wav.length / 1024).toFixed(0)}KB)`,
    );
  }
  console.log(`\nDone: ${TRACKS.length} tracks @ ${SAMPLE_RATE}Hz mono / ${DURATION_S}s.`);
}

main();
