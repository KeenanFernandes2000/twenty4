/**
 * Mock feed + social data — web-export screenshots only.
 *
 * The 3.1 feed, 3.2 player and 3.3 comments need a signed-in session + published
 * montages from other members; for the web export (no device, no API) we render
 * the SAME screens against deterministic mocks so the orchestrator can screenshot
 * every state in light/dark. A mock "mode" selects what to render:
 *
 *   items | empty
 *
 * Toggles (runtime wins), mirroring lib/montageMocks:
 *   - build-time env `EXPO_PUBLIC_MOCK_FEED`.
 *   - runtime global `globalThis.__TWENTY4_FEED_MOCK__` — set via a Playwright
 *     `addInitScript` BEFORE app boot, so ONE default web build screenshots any
 *     state without rebuilding.
 * Default (neither set) → 'off' (the real infinite query runs on a device).
 *
 * Pure data + the toggle read; no native imports, no side effects.
 */
import type { FeedCard, CommentResponse, ReactionSummary } from '@twenty4/contracts/dto';
import type { ReactionType } from '@twenty4/contracts/enums';

export type FeedMockMode = 'off' | 'items' | 'empty';

const VALID: ReadonlySet<string> = new Set(['items', 'empty']);

function normalize(v: unknown): FeedMockMode {
  return typeof v === 'string' && VALID.has(v) ? (v as FeedMockMode) : 'off';
}

/** Active feed mock mode (runtime override wins over the build-time env). */
export function feedMockMode(): FeedMockMode {
  const runtime = (globalThis as { __TWENTY4_FEED_MOCK__?: unknown }).__TWENTY4_FEED_MOCK__;
  const fromRuntime = normalize(runtime);
  if (fromRuntime !== 'off') return fromRuntime;
  return normalize(process.env.EXPO_PUBLIC_MOCK_FEED);
}

export function feedMockActive(): boolean {
  return feedMockMode() !== 'off';
}

const NOW = Date.now();

function summary(counts: Partial<Record<ReactionType, number>>, mine: ReactionType | null): ReactionSummary {
  const filled = { ...counts } as Record<string, number>;
  const total = Object.values(filled).reduce((a, b) => a + b, 0);
  return { counts: filled as ReactionSummary['counts'], total, mine };
}

const AUTHORS = [
  { id: '11111111-1111-1111-1111-111111111111', displayName: 'Maya Chen', username: 'maya', profilePhotoUrl: null },
  { id: '22222222-2222-2222-2222-222222222222', displayName: 'Leo Park', username: 'leop', profilePhotoUrl: null },
  { id: '33333333-3333-3333-3333-333333333333', displayName: 'Aisha N.', username: 'aisha', profilePhotoUrl: null },
] as const;

const GROUP = 'aaaaaaa1-1111-1111-1111-111111111111';

/** Three deterministic feed cards for the screenshots. */
export const MOCK_FEED_CARDS: FeedCard[] = [
  {
    montageId: 'bbbbbbb1-1111-1111-1111-111111111111',
    author: AUTHORS[0],
    thumbnailUrl: 'https://picsum.photos/seed/twenty4-feed-1/720/1280',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    durationMs: 30000,
    publishedAt: new Date(NOW - 35 * 60_000).toISOString(),
    expiryAt: new Date(NOW + (24 * 60 - 35) * 60_000).toISOString(),
    groupIds: [GROUP],
    reactions: summary({ fire: 4, heart: 2, laugh: 1 }, 'fire'),
    commentCount: 3,
  },
  {
    montageId: 'bbbbbbb2-2222-2222-2222-222222222222',
    author: AUTHORS[1],
    thumbnailUrl: 'https://picsum.photos/seed/twenty4-feed-2/720/1280',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
    durationMs: 30000,
    publishedAt: new Date(NOW - 2 * 3600_000).toISOString(),
    expiryAt: new Date(NOW + 22 * 3600_000).toISOString(),
    groupIds: [GROUP],
    reactions: summary({ heart: 5, like: 3 }, null),
    commentCount: 0,
  },
  {
    montageId: 'bbbbbbb3-3333-3333-3333-333333333333',
    author: AUTHORS[2],
    thumbnailUrl: 'https://picsum.photos/seed/twenty4-feed-3/720/1280',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    durationMs: 30000,
    publishedAt: new Date(NOW - 23 * 3600_000).toISOString(),
    expiryAt: new Date(NOW + 40 * 60_000).toISOString(), // < 1h → urgent countdown
    groupIds: [GROUP],
    reactions: summary({ shocked: 2, laugh: 6, fire: 1 }, 'laugh'),
    commentCount: 7,
  },
];

/** Display name for a group id (the publish-group mock copy). */
export const MOCK_GROUP_LABEL: Record<string, string> = {
  [GROUP]: 'Close Circle',
};

export function mockGroupLabel(ids: string[]): string {
  const names = ids.map((id) => MOCK_GROUP_LABEL[id]).filter(Boolean);
  return names[0] ?? 'a group';
}

/** Resolve the cards to render for the active mode. */
export function mockFeedCards(): FeedCard[] {
  return feedMockMode() === 'empty' ? [] : MOCK_FEED_CARDS;
}

/** Find a single mock card by id (3.2 player / 3.3 comments header). */
export function mockFeedCard(montageId: string | undefined): FeedCard | undefined {
  if (!montageId) return MOCK_FEED_CARDS[0];
  return MOCK_FEED_CARDS.find((c) => c.montageId === montageId) ?? MOCK_FEED_CARDS[0];
}

/** Deterministic comments for the 3.3 screenshot. */
export function mockComments(montageId: string): CommentResponse[] {
  return [
    {
      id: 'ccccccc1-1111-1111-1111-111111111111',
      montageId,
      author: AUTHORS[1],
      text: 'this is unreal, the golden hour shots 🔥',
      createdAt: new Date(NOW - 30 * 60_000).toISOString(),
    },
    {
      id: 'ccccccc2-2222-2222-2222-222222222222',
      montageId,
      author: AUTHORS[2],
      text: 'wait where was this?? need to go',
      createdAt: new Date(NOW - 18 * 60_000).toISOString(),
    },
    {
      id: 'ccccccc3-3333-3333-3333-333333333333',
      montageId,
      author: { id: '00000000-0000-0000-0000-000000000000', displayName: 'You', username: 'you', profilePhotoUrl: null },
      text: 'best one yet 😄',
      createdAt: new Date(NOW - 5 * 60_000).toISOString(),
    },
  ];
}
