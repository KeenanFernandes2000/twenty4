// Canonical placeholder-track metadata — shared by gen-music.mjs (synthesis) and
// precompute-beatgrids.mjs (grids + manifest). id/title/bpm are the cross-team
// fields; root/scale/*Gain are synthesis-only knobs. durationMs is fixed 30000.
export const DURATION_MS = 30000;

export const TRACKS = [
  { id: "chill", title: "Chill Haze", bpm: 90, root: 130.81, scale: [0, 3, 5, 7, 10], hatGain: 0.12, leadGain: 0.1 },
  { id: "party", title: "Party Pulse", bpm: 128, root: 164.81, scale: [0, 2, 4, 7, 9], hatGain: 0.28, leadGain: 0.16 },
  { id: "clean", title: "Clean Lines", bpm: 100, root: 146.83, scale: [0, 2, 4, 5, 7, 9, 11], hatGain: 0.18, leadGain: 0.12 },
  { id: "fast", title: "Fast Rush", bpm: 140, root: 196.0, scale: [0, 3, 5, 6, 7, 10], hatGain: 0.32, leadGain: 0.18 },
];
