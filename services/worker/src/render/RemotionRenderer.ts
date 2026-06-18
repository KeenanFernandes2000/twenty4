/**
 * RemotionRenderer (§7.2/§7.3) — the prototype renderer.
 *
 * Flow:
 *   1. bundle the `@twenty4/remotion` project ONCE (cached across renders).
 *   2. `selectComposition('Montage')` with the EDL (+ srcMap) as inputProps.
 *   3. `renderMedia({ codec:'h264', ... })` → MP4.
 *   4. thumbnail via `renderStill` (falls back to an ffmpeg frame extract).
 *   5. probe the real output → return { videoPath, thumbnailPath, durationMs, status }.
 *
 * §7.4 compliance: a hard timeout (default 5 min) races the render; on ANY failure
 * partial outputs are cleaned up so no orphaned files are left behind.
 *
 * Headless Chrome: Remotion downloads its own chrome-headless-shell via
 * `ensureBrowser()`. `browserExecutable` (or REMOTION_BROWSER_EXECUTABLE env) can
 * override it with, e.g., the Playwright headless shell already present here.
 */
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { mkdtemp, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import {
  ensureBrowser,
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
  type HeadlessBrowser,
} from '@remotion/renderer';
import type { Edl } from '@twenty4/contracts/edl';
import type { Renderer, RenderOptions, RenderResult } from './Renderer.js';
import { probe, extractFrame } from '../media/index.js';

const require = createRequire(import.meta.url);

/** Resolve the Remotion project entry the bundler should ingest. */
function resolveEntry(): string {
  return require.resolve('@twenty4/remotion/entry');
}

const FIVE_MIN_MS = 5 * 60 * 1000;
const COMPOSITION_ID = 'Montage';

/**
 * §10 render-speed tuning for the self-hosted box.
 *
 * Remotion's DEFAULT concurrency is `min(8, cpus/2)` — capped at 8 regardless of
 * core count, which under-uses a 24-core box. We size it to ~⅔ of the cores
 * (bounded 8..16) so the parallel CPU frame-raster + the parallel x264 encode
 * saturate the machine without thrashing. (Concurrency only pays off once GL is
 * off — see GL_BACKEND — otherwise a single shared GPU process serializes raster.)
 */
const DEFAULT_CONCURRENCY = (() => {
  const env = process.env.RENDER_CONCURRENCY;
  if (env && Number.isFinite(Number(env))) return Number(env);
  return Math.max(8, Math.min(16, Math.round((availableParallelism() * 2) / 3)));
})();

/**
 * The encode preset is the single biggest wall-clock lever. Default x264 'medium'
 * is ~3× slower than 'veryfast' for indistinguishable quality at 9:16 social
 * bitrates. crf 23 (vs Remotion's default ~18 for h264) shrinks the encode and the
 * file with no perceptible loss for short montages.
 */
const X264_PRESET = (process.env.RENDER_X264_PRESET ?? 'veryfast') as
  | 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium';
const CRF = process.env.RENDER_CRF ? Number(process.env.RENDER_CRF) : 23;

/**
 * Headless GL backend. Our composition uses only CSS filters/blend-modes/
 * gradients — NO WebGL/canvas — so it doesn't need GPU acceleration. `gl: 'angle'`
 * routed all tabs' raster through ONE shared ANGLE GPU process, serializing frame
 * rendering (concurrency couldn't scale: one chrome proc pegged ~600% while the
 * rest sat idle). `null` lets Chrome use its default CPU raster path, which
 * parallelizes per render tab. Overridable via RENDER_GL for the box.
 */
const GL_BACKEND: 'angle' | 'swiftshader' | 'swangle' | 'egl' | 'angle-egl' | 'vulkan' | null =
  process.env.RENDER_GL === 'null' || process.env.RENDER_GL === undefined
    ? null
    : (process.env.RENDER_GL as 'angle' | 'swiftshader' | 'swangle' | 'egl' | 'angle-egl' | 'vulkan');

/** Whether to reuse one shared browser across renders (default on). */
const SHARE_BROWSER = process.env.RENDER_SHARE_BROWSER !== '0';

/**
 * Bound the OffthreadVideo frame cache so sequential renders in one process don't
 * accumulate decoded-frame memory unboundedly. 512 MiB is ample for a single 30s
 * montage and keeps a long-lived worker process flat.
 */
const OFFTHREAD_VIDEO_CACHE_BYTES = 512 * 1024 * 1024;

export class RemotionRenderer implements Renderer {
  /** Cached webpack bundle (serveUrl/dir). Built lazily, once. */
  private bundlePromise: Promise<string> | null = null;
  /** Cached browser-ensure (download chrome-headless-shell once). */
  private browserPromise: Promise<void> | null = null;
  /**
   * A SINGLE long-lived headless browser shared across renders. Remotion would
   * otherwise spin up (and tear down) a fresh Chrome per `selectComposition`,
   * `renderMedia` AND `renderStill` call — three browser launches per montage.
   * Reusing one instance removes that per-render launch cost and, crucially,
   * stops sequential renders in one process from paying it repeatedly.
   */
  private browserInstance: HeadlessBrowser | null = null;
  private browserInstancePromise: Promise<HeadlessBrowser> | null = null;

  constructor(
    private readonly opts: {
      /** Pin a chrome executable (else Remotion manages its own). */
      browserExecutable?: string;
      /** Pre-warm the bundle at construction. */
      eager?: boolean;
    } = {},
  ) {
    if (opts.eager) void this.getBundle();
  }

  private getBundle(): Promise<string> {
    if (!this.bundlePromise) {
      const entry = resolveEntry();
      this.bundlePromise = bundle({
        entryPoint: entry,
        onProgress: () => undefined,
        // Our workspace packages (@twenty4/contracts, @twenty4/remotion) are
        // ESM-source TS that import siblings with explicit `.js` extensions (the
        // Node-ESM convention). Teach webpack to map `.js`→`.ts/.tsx` so the
        // composition bundle resolves them without us rewriting shared packages.
        webpackOverride: (config) => ({
          ...config,
          resolve: {
            ...config.resolve,
            extensionAlias: {
              ...(config.resolve?.extensionAlias ?? {}),
              '.js': ['.js', '.ts', '.tsx'],
              '.jsx': ['.jsx', '.tsx'],
            },
          },
        }),
      });
    }
    return this.bundlePromise;
  }

  private ensureBrowser(executable: string | null): Promise<void> {
    if (!this.browserPromise) {
      this.browserPromise = ensureBrowser({
        browserExecutable: executable ?? undefined,
      }).then(() => undefined);
    }
    return this.browserPromise;
  }

  /**
   * Open the shared headless browser ONCE and reuse it for every render. We pass
   * the same `puppeteerInstance` to selectComposition/renderMedia/renderStill so
   * no per-render Chrome launches happen. `gl: 'angle'` gives a fast, stable GPU
   * path for the composition's CSS filters under headless on Linux.
   */
  private getBrowser(executable: string | null): Promise<HeadlessBrowser> {
    if (this.browserInstance) return Promise.resolve(this.browserInstance);
    if (!this.browserInstancePromise) {
      this.browserInstancePromise = (async () => {
        await this.ensureBrowser(executable);
        const browser = await openBrowser('chrome', {
          browserExecutable: executable ?? undefined,
          chromiumOptions: { gl: GL_BACKEND },
        });
        this.browserInstance = browser;
        return browser;
      })();
    }
    return this.browserInstancePromise;
  }

  /**
   * Release the shared browser. Safe to call multiple times. In production each
   * montage is its own BullMQ job/process, but the harness (and any long-lived
   * worker) should call this to free Chrome cleanly on shutdown.
   */
  async close(): Promise<void> {
    const instance = this.browserInstance;
    this.browserInstance = null;
    this.browserInstancePromise = null;
    if (instance) {
      try {
        await instance.close({ silent: true });
      } catch {
        /* already gone */
      }
    }
  }

  async render(edl: Edl, options: RenderOptions = {}): Promise<RenderResult> {
    const timeoutMs = options.timeoutMs ?? FIVE_MIN_MS;
    const browserExecutable =
      options.browserExecutable ??
      this.opts.browserExecutable ??
      process.env.REMOTION_BROWSER_EXECUTABLE ??
      null;

    const outDir =
      options.outDir ?? (await mkdtemp(path.join(tmpdir(), 'twenty4-render-')));
    await mkdir(outDir, { recursive: true });
    const base = options.outBasename ?? `montage-${Date.now()}`;
    const videoPath = path.join(outDir, `${base}.mp4`);
    const thumbnailPath = path.join(outDir, `${base}.thumb.jpg`);

    const inputProps = { edl, srcMap: options.srcMap ?? {} };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Render exceeded hard timeout of ${timeoutMs}ms (§7.4)`)),
        timeoutMs,
      );
    });

    try {
      const result = await Promise.race([
        this.doRender({
          edl,
          inputProps,
          videoPath,
          thumbnailPath,
          browserExecutable,
          concurrency: options.concurrency ?? null,
          onProgress: options.onProgress,
        }),
        timeout,
      ]);
      return result;
    } catch (err) {
      // §7.4: never leave orphaned partial outputs.
      await safeUnlink(videoPath);
      await safeUnlink(thumbnailPath);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async doRender(args: {
    edl: Edl;
    inputProps: { edl: Edl; srcMap: Record<string, string> };
    videoPath: string;
    thumbnailPath: string;
    browserExecutable: string | null;
    concurrency: number | null;
    onProgress?: (p: number) => void;
  }): Promise<RenderResult> {
    const serveUrl = await this.getBundle();
    // ONE shared browser (reused across renders) when enabled. When sharing, we
    // pass `puppeteerInstance`; Remotion opens N tabs in it for frame concurrency.
    // When off, Remotion launches/tears down its own browser per call (with the
    // same `gl` backend via chromiumOptions).
    const puppeteerInstance = SHARE_BROWSER
      ? await this.getBrowser(args.browserExecutable)
      : undefined;
    const chromiumOptions = { gl: GL_BACKEND };

    const composition = await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps: args.inputProps,
      browserExecutable: args.browserExecutable ?? undefined,
      puppeteerInstance,
      chromiumOptions,
    });

    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation: args.videoPath,
      inputProps: args.inputProps,
      browserExecutable: args.browserExecutable ?? undefined,
      puppeteerInstance,
      chromiumOptions,
      // §10: saturate the box's cores (Remotion's default caps at 8) — only
      // effective with GL off so CPU raster parallelizes across render tabs.
      concurrency: args.concurrency ?? DEFAULT_CONCURRENCY,
      imageFormat: 'jpeg',
      jpegQuality: 80,
      // Encode-time lever (secondary to GL): 'veryfast'/crf 23 trims the x264
      // tail vs default 'medium' with no perceptible loss at 9:16 social bitrates.
      x264Preset: X264_PRESET,
      crf: CRF,
      // Bound the OffthreadVideo frame cache so a long-lived worker stays flat and
      // sequential renders don't accumulate decoded-frame memory.
      offthreadVideoCacheSizeInBytes: OFFTHREAD_VIDEO_CACHE_BYTES,
      onProgress: args.onProgress
        ? ({ progress }) => args.onProgress!(progress)
        : undefined,
    });

    // Thumbnail — prefer a Remotion still (frame 15 ≈ 0.5s) for color-accurate
    // theme grading; fall back to an ffmpeg frame extract if the still fails.
    try {
      await renderStill({
        composition,
        serveUrl,
        output: args.thumbnailPath,
        frame: 15,
        inputProps: args.inputProps,
        imageFormat: 'jpeg',
        jpegQuality: 80,
        browserExecutable: args.browserExecutable ?? undefined,
        puppeteerInstance,
        chromiumOptions,
      });
    } catch {
      await extractFrame(args.videoPath, args.thumbnailPath, 0.5, 540);
    }

    const probed = await probe(args.videoPath);

    return {
      videoPath: args.videoPath,
      thumbnailPath: args.thumbnailPath,
      durationMs: probed.durationMs,
      status: 'draft_ready',
    };
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await access(p);
    await rm(p, { force: true });
  } catch {
    /* nothing to clean up */
  }
}
