// Renderer interface (M7 §2/§3) — the swappable seam that makes the Remotion →
// Remotion-Lambda path a clean later drop-in with ZERO API/job-contract change. The
// render-montage job depends only on this interface; concrete renderers (Remotion
// here, Lambda later) live behind it.
import type { Edl } from "@twenty4/contracts";

export interface RenderResult {
  videoPath: string; // local path to the produced mp4
  thumbnailPath: string; // local path to the produced poster jpg
  durationMs: number;
}

export interface Renderer {
  // Render the EDL to a local mp4 + thumbnail. `srcMap` maps each segment.mediaRef
  // to an ABSOLUTE local path of the downloaded user media (music is NOT here — it
  // is bundled inside infra/remotion and referenced by the EDL's musicId).
  render(edl: Edl, srcMap: Record<string, string>): Promise<RenderResult>;
}
