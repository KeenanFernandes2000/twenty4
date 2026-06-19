/**
 * Mock Today data — web-export screenshots only.
 *
 * The real Today screen needs a signed-in session + running API; for the web
 * export (no device, no auth) we render the SAME grid against deterministic mock
 * items so the orchestrator can screenshot 2.1 (empty + populated) and the
 * upload tray in light/dark. Two toggles (either works; runtime wins):
 *   - build-time env `EXPO_PUBLIC_MOCK_TODAY` ("empty" | "items"/"1").
 *   - runtime global `globalThis.__TWENTY4_MOCK__` ("empty" | "items") — set via
 *     a Playwright `addInitScript` BEFORE app boot, so a single default web build
 *     can be screenshotted in either state without rebuilding/dotenv plumbing.
 * Default (neither set) → the real query runs (device).
 *
 * Pure data + the toggle read; no native imports, no side effects.
 */
import type { MediaItemResponse, TodayMediaResponse } from '@twenty4/contracts/dto';

import type { UploadTask } from '../stores/uploadStore';

export type MockMode = 'off' | 'empty' | 'items';

function normalize(v: unknown): MockMode {
  if (v === 'empty') return 'empty';
  if (v === 'items' || v === '1') return 'items';
  return 'off';
}

export function mockMode(): MockMode {
  // Runtime override (screenshots) takes precedence over the build-time env.
  const runtime = (globalThis as { __TWENTY4_MOCK__?: unknown }).__TWENTY4_MOCK__;
  const fromRuntime = normalize(runtime);
  if (fromRuntime !== 'off') return fromRuntime;
  return normalize(process.env.EXPO_PUBLIC_MOCK_TODAY);
}

const BUCKET = '2026-06-19';

// Deterministic placeholder previews (picsum is fine for a static screenshot;
// on a device the real presigned previewUrl is used instead).
function item(
  id: string,
  mediaType: 'photo' | 'video',
  validationStatus: MediaItemResponse['validationStatus'],
  seed: number,
  durationMs?: number,
): MediaItemResponse {
  return {
    id,
    mediaType,
    dayBucket: BUCKET,
    validationStatus,
    processingStatus: validationStatus === 'valid' ? 'valid' : 'validating',
    capturedInApp: seed % 2 === 0,
    deviceTimeSuspicious: false,
    durationMs: durationMs ?? null,
    width: 1080,
    height: 1920,
    previewUrl: `https://picsum.photos/seed/twenty4-${seed}/240/420`,
    createdAt: new Date(Date.UTC(2026, 5, 19, 12 + seed, 5 * seed)).toISOString(),
  };
}

export const MOCK_TODAY_ITEMS: TodayMediaResponse = {
  dayBucket: BUCKET,
  items: [
    item('11111111-1111-1111-1111-111111111111', 'photo', 'valid', 1),
    item('22222222-2222-2222-2222-222222222222', 'video', 'valid', 2, 8200),
    item('33333333-3333-3333-3333-333333333333', 'photo', 'valid', 3),
    item('44444444-4444-4444-4444-444444444444', 'photo', 'pending', 4),
    item('55555555-5555-5555-5555-555555555555', 'video', 'invalid', 5, 4100),
  ],
  validCount: 3,
};

export const MOCK_TODAY_EMPTY: TodayMediaResponse = {
  dayBucket: BUCKET,
  items: [],
  validCount: 0,
};

export function mockToday(mode: MockMode): TodayMediaResponse | null {
  if (mode === 'items') return MOCK_TODAY_ITEMS;
  if (mode === 'empty') return MOCK_TODAY_EMPTY;
  return null;
}

/** Mock upload tray tasks for the upload-progress screenshot. */
export const MOCK_UPLOAD_TASKS: UploadTask[] = [
  {
    localId: 'up-1',
    uri: '',
    label: 'IMG_4821.HEIC',
    progress: 1,
    status: 'done',
    attempt: 0,
    serverId: 'aaaa',
    dayBucket: BUCKET,
    createdAt: Date.now() - 40000,
    meta: { mediaType: 'photo', contentType: 'image/heic', sizeBytes: 2_400_000, capturedInApp: false },
  },
  {
    localId: 'up-2',
    uri: '',
    label: 'Camera capture',
    progress: 0.62,
    status: 'uploading',
    attempt: 0,
    serverId: 'bbbb',
    dayBucket: BUCKET,
    createdAt: Date.now() - 12000,
    meta: { mediaType: 'video', contentType: 'video/mp4', sizeBytes: 31_800_000, capturedInApp: true, durationMs: 9200 },
  },
  {
    localId: 'up-3',
    uri: '',
    label: 'VID_0099.MOV',
    progress: 0.18,
    status: 'failed',
    attempt: 1,
    error: 'Network error during upload',
    createdAt: Date.now() - 4000,
    meta: { mediaType: 'video', contentType: 'video/quicktime', sizeBytes: 58_200_000, capturedInApp: false, durationMs: 22000 },
  },
];
