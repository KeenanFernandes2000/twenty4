# @twenty4/remotion — M7 montage render subsystem

Self-contained Remotion `<Montage/>` composition + render driver for the M7
montage pipeline. **It receives plain JSON at runtime** (an EDL object + a srcMap)
and does **NOT** import `@twenty4/contracts` — keep it decoupled so it bundles and
runs cleanly on Node (Remotion spawns headless Chromium via puppeteer-core, which
requires Node, not Bun).

The EDL `Edl` TS type lives **locally** in `src/types.ts`. A parallel agent defines
the identical shape as a `.strict()` Zod schema in `packages/contracts/src/edl.ts` —
that schema is the single source of truth; `src/types.ts` mirrors it. Keep in sync.

## render.mjs — the spawn interface (FIXED CONTRACT)

The worker (`services/worker`) spawns this as a child process on **Node**:

```
node infra/remotion/render.mjs \
  --edl <edl.json path> \
  --srcmap <srcmap.json path> \
  --out <output dir> \
  [--gl null] [--concurrency 1] [--timeout 300000]
```

- `--edl` — path to a JSON file containing the validated EDL object.
- `--srcmap` — path to a JSON file `{ [mediaRef]: "/abs/local/temp/file.ext" }`: local
  paths of the downloaded **user** media (NOT the music — music is bundled here).
- `--out` — a directory; the driver writes:
  - `montage.mp4` — h264, 1080×1920, 30fps, 900 frames (~30s).
  - `thumb.jpg` — a `renderStill` at frame 30 (valid JPEG).
  - `result.json` — `{ durationMs, width:1080, height:1920, fps:30, codec:"h264",
    videoFile:"montage.mp4", thumbnailFile:"thumb.jpg" }`.
- `--gl` — `chromiumOptions.gl`. The literal string `null` maps to JS `null`
  (~9× faster than `'angle'`; PHASE1 recap §8.6). Default: `null`.
- `--concurrency` — renderMedia concurrency. Default `1`.
- `--timeout` — `timeoutInMilliseconds`. Default `300000` (5-min hard cap).

**Exit codes:** `0` on success; **non-zero** on any error (error printed to stderr).
The worker maps non-zero → a **retryable** render failure. `stdout` carries the
machine-readable `result.json` content on success; `stderr` carries progress logs.

**How it works:** Chrome blocks `file://` media, so the driver starts a local HTTP
file server over the srcMap files, rewrites the srcMap to `mediaRef → http://127.0.0.1:<port>/…`
(out-of-band), passes that as `inputProps.srcMap`, then `bundle()` → `selectComposition()`
→ `renderMedia({ codec:'h264', x264Preset:'veryfast', crf:23, chromiumOptions:{ gl } })`
→ `renderStill()`. The HTTP server is torn down in `finally`. The Remotion bundle is
cached in `$TMPDIR/twenty4-remotion-bundle-<srcHash>` and reused when sources are
unchanged.

## Music manifest + beat grids

Four **placeholder synth tracks** (no licensed audio — §11 default). Real licensed/CC0
tracks swap in without code change (drop a `<id>.wav` + re-run the scripts; the EDL
builder reads the same `*.beatgrid.json`).

- `public/music/<id>.wav` — the bundled audio (mono, 22.05kHz, 16-bit PCM, ~30s).
- `src/music/<id>.beatgrid.json` — `{ musicId, bpm, durationMs:30000, source, beatGrid:[…ms…] }`.
- `src/music/manifest.json` — `[{ id, title, durationMs:30000, bpm, file:"music/<id>.wav",
  beatgridFile:"src/music/<id>.beatgrid.json" }]`. The worker + API read this by filesystem path.

Tracks: `chill` (90bpm), `clean` (100bpm), `party` (128bpm), `fast` (140bpm).

**Beat-grid provenance:** `precompute-beatgrids.mjs` ATTEMPTS the essentia.js WASM
detector first (DSP, no ML), then falls back to a **tempo-derived** grid
(`beatMs = 60000/bpm`). Because these placeholders are synthesized at an EXACT known
BPM, the tempo-derived grid is the *ground truth* for them (more accurate than running
a detector over a synthetic signal, and free of WASM-in-CI fragility) — the checked-in
grids carry `"source":"tempo-derived"`. Real (unknown-tempo) tracks would run the
essentia path and carry `"source":"essentia.js"`.

### Regenerate music + grids

```
cd infra/remotion
node scripts/gen-music.mjs          # synth → public/music/*.wav
node scripts/precompute-beatgrids.mjs   # grids + manifest → src/music/*
# or: npm run gen:all
```

## Composition

`src/Root.tsx` registers `id="Montage"` (1080×1920, 30fps, 900 frames). `src/Montage.tsx`
lays each EDL segment on the timeline via `<Sequence>` + `<OffthreadVideo>` (videos,
trimmed `inMs..outMs`) / `<Img>` (photos, with per-theme Ken Burns), applies per-segment
`transition` (cut / crossfade / dipToBlack) and `overlay` (none / grain / vignette), and
lays the bundled `<Audio>` track. A missing srcMap entry renders a colored fallback frame
(never crashes).

## Future: Remotion Lambda (drop-in, not built here)

The worker owns the swappable `Renderer` interface. A `LambdaRenderer` would call
`renderMediaOnLambda({ composition:'Montage', inputProps:{ edl, srcMap }, codec:'h264', … })`
with the **same EDL + inputProps** — zero composition/API/job-contract change. The only
delta is media access (Lambda would read media from S3 URLs directly instead of the
local HTTP media server).
