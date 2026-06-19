/**
 * Mock montage data — web-export screenshots only.
 *
 * The montage flow (2.4–2.9) needs a signed-in session + a running render
 * worker; for the web export (no device, no API) we render the SAME screens
 * against deterministic mock data so the orchestrator can screenshot every
 * state in light/dark. The mock "mode" selects which montage status to render:
 *
 *   generating | draft_ready | published | failed
 *
 * Two toggles (runtime wins), mirroring lib/mediaMocks:
 *   - build-time env `EXPO_PUBLIC_MOCK_MONTAGE`.
 *   - runtime global `globalThis.__TWENTY4_MONTAGE_MOCK__` — set via a Playwright
 *     `addInitScript` BEFORE app boot, so one default web build screenshots any
 *     state without rebuilding.
 * Default (neither set) → 'off' (the real query/poll runs on a device).
 *
 * Pure data + the toggle read; no native imports, no side effects.
 */
import type {
  MontageResponse,
  MontageOptionsResponse,
} from '@twenty4/contracts/dto';
import type { MontageStatus } from '@twenty4/contracts/enums';

export type MontageMockMode = 'off' | MontageStatus;

const VALID_MODES: ReadonlySet<string> = new Set([
  'generating',
  'draft_ready',
  'published',
  'failed',
]);

function normalize(v: unknown): MontageMockMode {
  return typeof v === 'string' && VALID_MODES.has(v) ? (v as MontageMockMode) : 'off';
}

/** Active montage mock mode (runtime override wins over the build-time env). */
export function montageMockMode(): MontageMockMode {
  const runtime = (globalThis as { __TWENTY4_MONTAGE_MOCK__?: unknown }).__TWENTY4_MONTAGE_MOCK__;
  const fromRuntime = normalize(runtime);
  if (fromRuntime !== 'off') return fromRuntime;
  return normalize(process.env.EXPO_PUBLIC_MOCK_MONTAGE);
}

/** True when ANY montage mock is active (screens skip the real query). */
export function montageMockActive(): boolean {
  return montageMockMode() !== 'off';
}

export const MOCK_MONTAGE_ID = '99999999-9999-9999-9999-999999999999';

/** A deterministic montage row for the given status. */
export function mockMontage(status: MontageStatus): MontageResponse {
  const ready = status === 'draft_ready' || status === 'published';
  const published = status === 'published';
  // Anchor the lifecycle to the real clock so the published countdown reads a
  // sensible ~24h in the screenshot regardless of when it runs.
  const NOW = Date.now();
  return {
    id: MOCK_MONTAGE_ID,
    userId: '11111111-1111-1111-1111-111111111111',
    status,
    theme: 'Chill',
    musicId: 'golden-hour',
    durationMs: 30000,
    // A bundled placeholder so the web player shows a real first frame; on a
    // device the presigned previewUrl is used instead.
    videoUrl: ready
      ? 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4'
      : null,
    thumbnailUrl: ready ? 'https://picsum.photos/seed/twenty4-montage/720/1280' : null,
    publishedAt: published ? new Date(NOW).toISOString() : null,
    expiryAt: published ? new Date(NOW + 24 * 3600_000).toISOString() : null,
    createdAt: new Date(NOW - 60_000).toISOString(),
  };
}

/** Resolve the mock montage for the active mode, or null when off. */
export function mockMontageForMode(): MontageResponse | null {
  const mode = montageMockMode();
  if (mode === 'off') return null;
  return mockMontage(mode);
}

/** Bundled options (themes + music) for the 2.6 / 2.7 pickers on web. */
export const MOCK_MONTAGE_OPTIONS: MontageOptionsResponse = {
  themes: ['Chill', 'Party', 'Clean', 'Travel', 'Fast Cut', 'Soft', 'Mellow', 'Random'],
  defaultTheme: 'Chill',
  defaultMusicId: 'golden-hour',
  music: [
    { id: 'golden-hour', label: 'Golden Hour', bpm: 90, synthesized: true },
    { id: 'slow-sunday', label: 'Slow Sunday', bpm: 78, synthesized: true },
    { id: 'city-lights', label: 'City Lights', bpm: 124, synthesized: true },
    { id: 'no-music', label: 'No music', bpm: 1 },
  ],
};

/** Mock groups for the 2.8 publish multi-select on web. */
export const MOCK_PUBLISH_GROUPS = [
  { id: 'aaaaaaa1-1111-1111-1111-111111111111', name: 'Close Circle', memberCount: 6 },
  { id: 'aaaaaaa2-2222-2222-2222-222222222222', name: 'Roommates', memberCount: 4 },
  { id: 'aaaaaaa3-3333-3333-3333-333333333333', name: 'Hiking crew', memberCount: 11 },
];
