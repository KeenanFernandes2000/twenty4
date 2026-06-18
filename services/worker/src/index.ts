/**
 * @twenty4/worker entry.
 *
 * SLICE 1 (this agent) authored the RENDER half only — the `Renderer` interface,
 * `RemotionRenderer`, the factory, and media helpers. The BullMQ Workers and the
 * intelligence layer (beat analysis → scoring → EDL build) are authored by a
 * SEPARATE agent in the next slice; this entry deliberately wires nothing yet.
 *
 * What the intelligence agent must produce and hand to the renderer:
 *   - a valid `Edl` (`@twenty4/contracts/edl`) — see `infra/remotion` sampleEdl
 *     `buildBeatAlignedEdl` for the exact shape and a working reference builder.
 *   - a `srcMap` (mediaRef → file:// path) after downloading S3 media to a temp
 *     dir; pass it as `RenderOptions.srcMap`.
 * Then: `getRenderer().render(edl, { srcMap, outDir })` → upload videoPath/thumb.
 */
export { getRenderer, RemotionRenderer } from './render/index.js';
export type {
  Renderer,
  RenderOptions,
  RenderResult,
  RenderStatus,
  SrcMap,
} from './render/index.js';
export * as media from './media/index.js';

// Running this file directly is a no-op for now (queue wiring lands next slice).
if (import.meta.url === `file://${process.argv[1]}`) {
  // eslint-disable-next-line no-console
  console.log(
    '@twenty4/worker: render half ready. Queue + intelligence wiring is next slice.',
  );
}
