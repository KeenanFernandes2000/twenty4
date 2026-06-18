/**
 * Renderer interface (§7.2) — the swappable seam between the montage intelligence
 * (which emits an `Edl`) and whatever turns that EDL into an MP4.
 *
 *   Renderer.render(EditDecisionList) -> { videoPath, thumbnailPath, durationMs, status }
 *
 * Prototype impl: `RemotionRenderer` (single self-hosted worker, `@remotion/renderer`).
 * Future: a `LambdaRenderer` (`renderMediaOnLambda`) slots in behind this same
 * interface with no caller change (§7.2 "Future enhancement").
 */
import type { Edl } from '@twenty4/contracts/edl';

/** Where the renderer can load each EDL `mediaRef` from (S3 keys → local/URL). */
export type SrcMap = Record<string, string>;

export interface RenderOptions {
  /**
   * Resolves EDL `mediaRef`s to browser-loadable sources (file://, http(s), or a
   * Remotion-public-relative path). The render half is storage-agnostic; the job
   * layer downloads from S3 to a temp dir and supplies file:// paths here.
   */
  srcMap?: SrcMap;
  /** Output directory for the video + thumbnail (defaults to an OS temp dir). */
  outDir?: string;
  /** Base filename (no extension) for outputs. Default: `montage-<timestamp>`. */
  outBasename?: string;
  /** Hard timeout in ms (§7.4 → 5 min). */
  timeoutMs?: number;
  /** Override the Chrome/Chromium executable (headless). */
  browserExecutable?: string;
  /** Render concurrency (Remotion). Default: auto. */
  concurrency?: number | null;
  /** Optional progress callback (0..1). */
  onProgress?: (progress: number) => void;
}

export type RenderStatus = 'draft_ready' | 'failed';

export interface RenderResult {
  /** Absolute path to the rendered MP4. */
  videoPath: string;
  /** Absolute path to the generated thumbnail (JPEG). */
  thumbnailPath: string;
  /** Real output duration in ms (probed, not assumed). */
  durationMs: number;
  /** §7.2 status — `draft_ready` on success. */
  status: RenderStatus;
}

export interface Renderer {
  render(edl: Edl, opts?: RenderOptions): Promise<RenderResult>;
  /**
   * Release long-lived resources (e.g. a shared headless browser). Optional and
   * idempotent. A short-lived BullMQ job process can skip it (process exit frees
   * everything); a long-lived worker or the gate harness should call it on
   * shutdown so Chrome is torn down cleanly.
   */
  close?(): Promise<void>;
}
