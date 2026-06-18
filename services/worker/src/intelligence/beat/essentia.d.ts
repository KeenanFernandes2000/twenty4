/**
 * Minimal ambient types for `essentia.js` (0.1.3 ships no declarations).
 *
 * Only the surface we use is typed; everything else stays `unknown`. The real
 * `Essentia` instance exposes ~250 algorithm methods — we narrow just the ones
 * the beat analyzer calls.
 */
declare module 'essentia.js' {
  /** A construct-able Essentia core; takes the WASM module. */
  export const Essentia: new (wasm: unknown) => unknown;
  /** The compiled WASM module (sometimes nested under `.EssentiaWASM`). */
  export const EssentiaWASM: unknown;
  export const EssentiaExtractor: unknown;
  export const EssentiaModel: unknown;
  export const EssentiaPlot: unknown;
}
