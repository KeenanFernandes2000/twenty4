// LOCAL EDL type — intentionally NOT imported from @twenty4/contracts.
// This subsystem runs on Node and is bundled by Remotion's esbuild; it must stay
// decoupled from the contracts package (which uses .ts-extension/bundler imports
// Node can't resolve). A parallel agent defines the SAME shape as a strict Zod
// schema in packages/contracts — this is the fixed cross-team contract. Keep in sync.

export type Theme =
  | "chill"
  | "party"
  | "clean"
  | "travel"
  | "random"
  | "fast_cut"
  | "soft";

export type Transition = "cut" | "crossfade" | "dipToBlack";

export type Overlay = "none" | "grain" | "vignette";

export type MediaType = "photo" | "video";

export interface ThemeStyle {
  theme: Theme;
  transition: Transition;
  cutDensity: number;
  overlay: Overlay;
}

export interface EdlAudio {
  musicId: string;
  /** "music/<id>.wav" — resolved against this project's public dir via staticFile() */
  srcRef: string;
  /** beat onsets in ms */
  beatGrid: number[];
}

export interface Segment {
  /** opaque key into srcMap → an http URL at render time */
  mediaRef: string;
  mediaType: MediaType;
  /** trim window start within the source media (ms) */
  inMs: number;
  /** trim window end within the source media (ms) */
  outMs: number;
  /** placement on the 30s timeline (ms) */
  startMs: number;
  /** length on the timeline (ms) */
  durationMs: number;
  transition: Transition;
  overlay?: Overlay | null;
}

export interface Edl {
  width: 1080;
  height: 1920;
  fps: 30;
  durationMs: 30000;
  musicId: string;
  themeStyle: ThemeStyle;
  audio: EdlAudio;
  segments: Segment[];
  beatGrid: number[];
}

/** mediaRef → resolvable URL (http at render time). Music is NOT in here (bundled). */
export type SrcMap = Record<string, string>;

export interface MontageProps {
  edl: Edl;
  srcMap: SrcMap;
}
