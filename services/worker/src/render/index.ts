/**
 * Render factory (§7.2) — returns the active `Renderer` implementation.
 *
 * Prototype: a single cached `RemotionRenderer`. Swapping to Lambda later means
 * returning a `LambdaRenderer` here; no caller changes (the EDL contract and the
 * `Renderer` interface are unchanged).
 */
import { RemotionRenderer } from './RemotionRenderer.js';
import type { Renderer } from './Renderer.js';

let singleton: Renderer | null = null;

export function getRenderer(): Renderer {
  if (!singleton) {
    singleton = new RemotionRenderer({
      browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE,
    });
  }
  return singleton;
}

export { RemotionRenderer } from './RemotionRenderer.js';
export type {
  Renderer,
  RenderOptions,
  RenderResult,
  RenderStatus,
  SrcMap,
} from './Renderer.js';
