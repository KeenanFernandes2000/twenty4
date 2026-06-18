/**
 * Montage intelligence barrel (§7.1) — the algorithmic, no-ML layer that turns a
 * pool of scored media + a track's beat grid + a theme into a contracts-valid
 * `Edl` (which the renderer then turns into the 9:16 / 30s MP4).
 *
 *   analyzeBeats  — beat grid from audio (essentia.js primary, PCM fallback)
 *   scoreMedia    — per-clip motion/sharpness/brightness/face scoring
 *   buildEdl      — beat-synced 30s allocation → the EDL
 *   resolveTheme  — Random → concrete theme
 */
export { analyzeBeats, smokeEssentia, decodePcm } from './beat/analyze.js';
export type { BeatGridResult, BeatSource } from './beat/analyze.js';

export { scoreMedia, scoreMany } from './scoring/score.js';
export type { ClipScore, ScorableItem } from './scoring/score.js';

export { buildEdl } from './edl/build.js';
export type { BuildEdlInput, BuildItem, BuildTrack } from './edl/build.js';

export {
  getThemeParams,
  resolveTheme,
  THEME_PARAMS,
  type ThemeParams,
} from './themes.js';
