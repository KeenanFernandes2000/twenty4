/**
 * Mock safety data — web-export screenshots only.
 *
 * The 5.5 Blocked-users list and the 7.5 Suspended gate need a signed-in session
 * + server state; for the web export (no device, no API) we render the SAME
 * screens against deterministic mocks so the orchestrator can screenshot them in
 * light/dark. Mirrors lib/feedMocks:
 *   - runtime global `globalThis.__TWENTY4_SAFETY_MOCK__` — set via a Playwright
 *     `addInitScript` BEFORE app boot ('blocked' | 'blocked-empty' | 'suspended').
 *   - build-time env `EXPO_PUBLIC_MOCK_SAFETY`.
 * Default (neither set) → 'off' (the real queries run on a device).
 *
 * Pure data + the toggle read; no native imports, no side effects.
 */
import type { UserSummary } from '@twenty4/contracts/dto';

export type SafetyMockMode = 'off' | 'blocked' | 'blocked-empty' | 'suspended';

const VALID: ReadonlySet<string> = new Set(['blocked', 'blocked-empty', 'suspended']);

function normalize(v: unknown): SafetyMockMode {
  return typeof v === 'string' && VALID.has(v) ? (v as SafetyMockMode) : 'off';
}

/** Active safety mock mode (runtime override wins over the build-time env). */
export function safetyMockMode(): SafetyMockMode {
  const runtime = (globalThis as { __TWENTY4_SAFETY_MOCK__?: unknown }).__TWENTY4_SAFETY_MOCK__;
  const fromRuntime = normalize(runtime);
  if (fromRuntime !== 'off') return fromRuntime;
  return normalize(process.env.EXPO_PUBLIC_MOCK_SAFETY);
}

export function safetyMockActive(): boolean {
  return safetyMockMode() !== 'off';
}

/** Deterministic blocked users for the 5.5 screenshot. */
export const MOCK_BLOCKED_USERS: UserSummary[] = [
  {
    id: '44444444-4444-4444-4444-444444444444',
    displayName: 'Jordan Reyes',
    username: 'jordanr',
    profilePhotoUrl: null,
  },
  {
    id: '55555555-5555-5555-5555-555555555555',
    displayName: 'Sam Okafor',
    username: 'samok',
    profilePhotoUrl: null,
  },
];

/** Resolve the blocked list to render for the active mode. */
export function mockBlockedUsers(): UserSummary[] {
  return safetyMockMode() === 'blocked-empty' ? [] : MOCK_BLOCKED_USERS;
}
