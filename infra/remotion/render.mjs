#!/usr/bin/env node
// render.mjs — the M7 render driver. The worker (services/worker, on Node)
// SPAWNS this as a child process. This CLI contract is a FIXED cross-team
// interface — do not change flags/outputs without coordinating.
//
//   node infra/remotion/render.mjs \
//     --edl <edl.json> --srcmap <srcmap.json> --out <output dir> \
//     [--gl null] [--concurrency 1] [--timeout 300000] [--port 0]
//
//   --edl        : JSON file with the validated EDL object.
//   --srcmap     : JSON file { [mediaRef]: "/abs/local/file.ext" } — downloaded USER
//                  media (NOT music; music is bundled in this project's public dir).
//   --out        : directory; receives montage.mp4 + thumb.jpg + result.json.
//   --gl         : chromiumOptions.gl. The literal "null" maps to JS null (~9x faster
//                  than 'angle' — PHASE1 recap §8.6). Default: null.
//   --concurrency: renderMedia concurrency (default 1).
//   --timeout    : per-frame/total timeoutInMilliseconds (default 300000 = 5min).
//   --port       : local media-server port (default 0 = ephemeral OS-assigned).
//
// Flow: read edl+srcmap → start a local HTTP file server for the user media →
// build a mediaRef→httpURL srcMap → bundle the composition → selectComposition →
// renderMedia(h264) → renderStill(thumb) → write result.json → tear everything
// down in finally → exit 0. ANY error: log to stderr + exit non-zero (the worker
// maps non-zero to a RETRYABLE render failure).
//
// NOTE: a future Remotion **Lambda** renderer is a drop-in: renderMediaOnLambda()
// takes the SAME { edl, srcMap } inputProps + composition id — no contract change.
import { createServer } from "node:http";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { bundle } from "@remotion/bundler";
import {
  selectComposition,
  renderMedia,
  renderStill,
} from "@remotion/renderer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, "src", "index.ts");
const PUBLIC_DIR = join(__dirname, "public");

const log = (...a) => console.error("[render]", ...a);

// ---- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

// ---- local media HTTP server (Chrome blocks file://) -----------------------
// port: 0 (default) = ephemeral OS-assigned port; non-zero pins a fixed port.
function startMediaServer(routes, port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        const local = routes.get(decodeURIComponent(url.pathname));
        if (!local || !existsSync(local)) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const stat = statSync(local);
        const type = CONTENT_TYPES[extname(local).toLowerCase()] || "application/octet-stream";
        const range = req.headers.range;
        res.setHeader("Content-Type", type);
        res.setHeader("Accept-Ranges", "bytes");
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          let start = m && m[1] ? parseInt(m[1], 10) : 0;
          let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (Number.isNaN(start)) start = 0;
          if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
          if (start > end) {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${stat.size}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          res.setHeader("Content-Length", end - start + 1);
          createReadStream(local, { start, end }).pipe(res);
        } else {
          res.statusCode = 200;
          res.setHeader("Content-Length", stat.size);
          createReadStream(local).pipe(res);
        }
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// ---- bundle cache (skip re-bundle when sources unchanged) -------------------
function hashSources() {
  const h = createHash("sha1");
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        h.update(name);
        h.update(String(st.size));
        h.update(String(st.mtimeMs));
      }
    }
  };
  walk(join(__dirname, "src"));
  walk(PUBLIC_DIR);
  h.update(readFileSync(join(__dirname, "remotion.config.ts")));
  h.update(readFileSync(join(__dirname, "package.json")));
  return h.digest("hex").slice(0, 16);
}

async function getServeUrl() {
  const cacheDir = join(tmpdir(), `twenty4-remotion-bundle-${hashSources()}`);
  if (existsSync(join(cacheDir, "index.html"))) {
    log("reusing cached bundle:", cacheDir);
    return cacheDir;
  }
  log("bundling composition (first run / sources changed)…");
  const serveUrl = await bundle({
    entryPoint: ENTRY,
    publicDir: PUBLIC_DIR,
    outDir: cacheDir,
    onProgress: (p) => {
      if (p % 25 === 0) log(`  bundle ${p}%`);
    },
  });
  return serveUrl;
}

async function main() {
  const args = parseArgs(process.argv);
  const edlPath = args.edl;
  const srcmapPath = args.srcmap;
  const outDir = args.out;
  if (!edlPath || !srcmapPath || !outDir) {
    throw new Error(
      "usage: render.mjs --edl <file> --srcmap <file> --out <dir> [--gl null] [--concurrency 1] [--timeout 300000] [--port 0]",
    );
  }
  const glArg = args.gl ?? "null";
  const gl = glArg === "null" ? null : glArg; // literal "null" → JS null
  const concurrency = args.concurrency ? parseInt(args.concurrency, 10) : 1;
  const timeoutInMilliseconds = args.timeout ? parseInt(args.timeout, 10) : 300000;
  // --port: 0/absent = ephemeral OS-assigned port (the safe default); non-zero pins it.
  const mediaPort = Number.parseInt(args.port ?? "0", 10) || 0;

  const edl = JSON.parse(readFileSync(edlPath, "utf8"));
  const srcMap = JSON.parse(readFileSync(srcmapPath, "utf8"));
  mkdirSync(outDir, { recursive: true });

  // Build URL-safe routes (mediaRefs can contain '/'); preserve extension so the
  // server can set a correct Content-Type for OffthreadVideo/Img.
  const routes = new Map();
  const refKeys = Object.keys(srcMap);
  refKeys.forEach((ref, i) => {
    const local = srcMap[ref];
    const route = `/m${i}${extname(local) || ""}`;
    routes.set(route, local);
  });

  let server;
  try {
    server = await startMediaServer(routes, mediaPort);
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const httpSrcMap = {};
    refKeys.forEach((ref, i) => {
      httpSrcMap[ref] = `${base}/m${i}${extname(srcMap[ref]) || ""}`;
    });
    log(`media server on ${base} serving ${refKeys.length} file(s); gl=${gl}`);

    const inputProps = { edl, srcMap: httpSrcMap };
    const serveUrl = await getServeUrl();

    const composition = await selectComposition({
      serveUrl,
      id: "Montage",
      inputProps,
    });
    log(
      `composition ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} frames`,
    );

    const videoFile = "montage.mp4";
    const thumbnailFile = "thumb.jpg";
    const videoOut = join(outDir, videoFile);
    const thumbOut = join(outDir, thumbnailFile);

    const t0 = Date.now();
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: videoOut,
      inputProps,
      imageFormat: "jpeg",
      crf: 23,
      x264Preset: "veryfast",
      concurrency,
      timeoutInMilliseconds,
      chromiumOptions: { gl },
      onProgress: ({ progress }) => {
        const pct = Math.round(progress * 100);
        if (pct % 20 === 0) log(`  render ${pct}%`);
      },
    });
    log(`renderMedia done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    await renderStill({
      composition,
      serveUrl,
      frame: 30,
      output: thumbOut,
      inputProps,
      imageFormat: "jpeg",
      jpegQuality: 90,
      chromiumOptions: { gl },
      timeoutInMilliseconds,
    });
    log("renderStill (thumb.jpg) done");

    const result = {
      durationMs: edl.durationMs,
      width: 1080,
      height: 1920,
      fps: 30,
      codec: "h264",
      videoFile,
      thumbnailFile,
    };
    writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
    // stdout carries the machine-readable result; stderr carries progress logs.
    process.stdout.write(JSON.stringify(result) + "\n");
    log("wrote result.json");
  } finally {
    if (server) {
      await new Promise((r) => server.close(r));
      log("media server torn down");
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[render] FATAL:", err?.stack || err?.message || String(err));
    process.exit(1);
  });
