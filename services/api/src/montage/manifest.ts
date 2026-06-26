// Bundled-music manifest loader (M7) — reads the precomputed track manifest the
// Remotion render driver ships at `<INFRA_REMOTION_DIR>/src/music/manifest.json`.
//
// The API only needs the lightweight {id,title,durationMs,bpm} facet for two
// things: GET /montages/options (the picker feed) and choosing a DEFAULT musicId
// when the generate request omits one. The full track row also carries `file` /
// `beatgridFile` (the worker's concern) — we strip those here.
//
// The file is read once per resolved path and cached (it is checked-in, static).
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Theme } from "@twenty4/contracts";

// The picker-facing shape (the .strict() montageOptions track schema mirrors this).
export interface Track {
  id: string;
  title: string;
  durationMs: number;
  bpm: number;
}

// The raw manifest row (superset — we drop file/beatgridFile for the API surface).
interface RawTrack extends Track {
  file?: string;
  beatgridFile?: string;
}

// Resolve the manifest path from INFRA_REMOTION_DIR. The env default ("infra/
// remotion") is repo-root-relative, but the API runs from differing cwds (repo
// root in prod, services/api under `bun test`). So for a relative dir we probe
// process.cwd() then walk up from this module until we find the manifest.
function resolveManifestPath(remotionDir: string): string {
  const rel = join("src", "music", "manifest.json");
  if (isAbsolute(remotionDir)) return join(remotionDir, rel);

  const bases: string[] = [process.cwd()];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    bases.push(dir);
    dir = dirname(dir);
  }
  for (const base of bases) {
    const candidate = join(base, remotionDir, rel);
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to a cwd-relative path so the read throws a clear ENOENT if missing.
  return join(process.cwd(), remotionDir, rel);
}

const cache = new Map<string, Track[]>();

// Load + cache the manifest tracks (picker facet) for the given remotion dir.
export function loadTracks(remotionDir: string): Track[] {
  const path = resolveManifestPath(remotionDir);
  const cached = cache.get(path);
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawTrack[];
  const tracks: Track[] = raw.map((t) => ({
    id: t.id,
    title: t.title,
    durationMs: t.durationMs,
    bpm: t.bpm,
  }));
  cache.set(path, tracks);
  return tracks;
}

// The default theme applied when POST /montages omits one (§11: a neutral pick).
export const DEFAULT_THEME: Theme = "clean";

// Theme → preferred track id. The bundled set ships chill/party/clean/fast; themes
// without a same-named track map to a sensible bundled one (the worker is free to
// re-pick). Falls back to the first manifest track if the preferred id is absent.
const THEME_TRACK: Record<Theme, string> = {
  chill: "chill",
  party: "party",
  clean: "clean",
  travel: "chill",
  random: "chill",
  fast_cut: "fast",
  soft: "chill",
};

// Choose the default musicId for a theme from the loaded manifest.
export function defaultMusicId(theme: Theme, tracks: Track[]): string {
  const preferred = THEME_TRACK[theme];
  if (tracks.some((t) => t.id === preferred)) return preferred;
  return tracks[0]?.id ?? preferred;
}
