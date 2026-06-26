// Bundled-track loader (M7 §3) — reads the infra/remotion music manifest + the
// PRECOMPUTED beat grids by FILESYSTEM PATH (request-time path never re-runs
// essentia; the grids are checked in next to each track). INFRA_REMOTION_DIR is
// resolved robustly (cwd then walk-up from this module) via resolveInfraDir.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env, Theme } from "@twenty4/contracts";
import type { EdlTrack } from "../intelligence/edl/build.ts";
import { resolveInfraDir } from "./infraDir.ts";

export interface TrackManifestEntry {
  id: string;
  title: string;
  durationMs: number;
  bpm: number;
  file: string; // "music/<id>.wav"
  beatgridFile: string; // "src/music/<id>.beatgrid.json"
}

export function loadManifest(env: Env): TrackManifestEntry[] {
  const path = join(resolveInfraDir(env), "src", "music", "manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as TrackManifestEntry[];
}

export function loadBeatGrid(env: Env, musicId: string): number[] {
  const path = join(resolveInfraDir(env), "src", "music", `${musicId}.beatgrid.json`);
  const json = JSON.parse(readFileSync(path, "utf8")) as { beatGrid: number[] };
  return json.beatGrid;
}

// Default track per theme (placeholder mapping; real catalog swaps in unchanged).
const THEME_TRACK: Record<Theme, string> = {
  chill: "chill",
  soft: "chill",
  party: "party",
  random: "party",
  clean: "clean",
  travel: "clean",
  fast_cut: "fast",
};

// Resolve the track to render with: an explicit (manifest-known) musicId wins, else
// the theme default, else the first manifest entry. Loads its precomputed beat grid.
export function selectTrack(env: Env, opts: { musicId?: string | null; theme: Theme }): EdlTrack {
  const manifest = loadManifest(env);
  if (manifest.length === 0) throw new Error("music manifest is empty");

  let entry =
    (opts.musicId && manifest.find((m) => m.id === opts.musicId)) ||
    manifest.find((m) => m.id === THEME_TRACK[opts.theme]) ||
    manifest[0]!;

  return { id: entry.id, bpm: entry.bpm, beatGrid: loadBeatGrid(env, entry.id) };
}
