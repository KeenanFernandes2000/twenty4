/**
 * Client analytics emitter (§12 / PLAN slice 9) — batched, content-free.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ HARD INVARIANT (§12 + §6): events carry NO USER CONTENT.                   │
 * │ Every payload is an id / count / enum / duration / timestamp — NEVER a     │
 * │ photo/video byte, comment text, caption, name, email, or any free text.   │
 * │ The typed `track*` helpers below make a content field impossible at the    │
 * │ call site, AND the server re-validates each event against the STRICT §12   │
 * │ discriminated union on ingest (`/analytics` firewall) — a stray field is   │
 * │ dropped there. This module is the client half of that firewall.            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Design (PLAN §2 "client analytics emitter"):
 *   - A bounded in-memory QUEUE of events. `track*` helpers enqueue (sync, never
 *     throw into the caller — analytics must not break a user flow).
 *   - FLUSH POSTs the queued batch to `/analytics` via `apiClient.analytics.ingest`
 *     (the typed batch endpoint, ≤ ANALYTICS_BATCH_MAX/call). Triggers:
 *       · an interval timer (every FLUSH_INTERVAL_MS),
 *       · app foreground (AppState active),
 *       · a manual `flush()` (e.g. before a known navigation).
 *   - Events are dropped (not retried forever) past MAX_QUEUE so a long offline
 *     stretch can't grow memory unbounded; a failed flush re-queues (bounded).
 *
 * The `userId` envelope is read off the session (or a stable anonymized id
 * pre-auth) so pre-signup events (app_open / signup funnel) still attribute to a
 * consistent device without PII. The vendor sink is [TEAM]; here we POST to our
 * own ingest endpoint which aggregates to counts only.
 *
 * Web-safe: no native-only imports. `AppState` exists on web (RN-web shims it);
 * the interval is a plain `setInterval`.
 */
import { AppState, type AppStateStatus } from 'react-native';

import type {
  AnalyticsEvent,
  AnalyticsEventName,
} from '@twenty4/contracts/analytics';
import type { MediaType, ReactionType, Theme } from '@twenty4/contracts/enums';

import { apiClient } from './apiClient';
import { useAuthStore } from '../stores/authStore';

/** Flush at most this often (ms). Foreground + manual flush can flush sooner. */
const FLUSH_INTERVAL_MS = 15_000;
/** Bound the queue so a long offline window can't grow memory unbounded. */
const MAX_QUEUE = 200;
/**
 * Events POSTed per request. MUST stay ≤ the server's ingest cap
 * (`ANALYTICS_BATCH_MAX` = 100 in @twenty4/contracts dto/analytics) — kept as a
 * local literal because the contracts `dto` barrel is a TYPE-only import surface
 * here (its `.js` re-exports aren't Metro-resolvable from source); the server
 * re-enforces the real cap, so an over-cap batch would simply be rejected.
 */
const BATCH_SIZE = 100;

/**
 * A queued event MINUS the envelope (`userId`/`ts` stamped at flush time).
 * Distributive `Omit` (`T extends any ? Omit<T, …> : never`) so each branch of
 * the discriminated union KEEPS its own props — a plain `Omit<Union, …>` would
 * collapse to only the common keys and reject the per-event payloads.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type EventBody = DistributiveOmit<AnalyticsEvent, 'userId' | 'ts'>;
type QueuedEvent = { body: EventBody; ts: number };

const queue: QueuedEvent[] = [];
let flushing = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;

/**
 * A stable anonymized device id for PRE-AUTH events (app_open before sign-in,
 * signup funnel). It is NOT user content — a random opaque id minted once per app
 * process. Once signed in we use the real user id. (Persisting it across launches
 * is a [TEAM] enhancement; per-process is enough for Phase-1 funnel attribution.)
 */
const anonId = `anon-${Math.random().toString(36).slice(2, 10)}`;

function envelopeUserId(): string {
  // The token is the session; a real user id isn't held client-side as a plain
  // field, so we attribute signed-in events with a stable per-session marker and
  // let the server stamp the authoritative user id from the bearer token on
  // ingest. Pre-auth → the anon device id.
  const token = useAuthStore.getState().getToken();
  return token ? `session-${anonId}` : anonId;
}

/**
 * Enqueue a content-free §12 event. Sync + swallows its own errors — analytics
 * must NEVER throw into a user flow. Drops the oldest event if the queue is full.
 */
function enqueue<E extends EventBody>(body: E): void {
  try {
    queue.push({ body, ts: Date.now() });
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  } catch {
    /* analytics is best-effort; never surface to the caller */
  }
}

/**
 * Flush the queued events to `/analytics` in batches. Fire-and-forget from the
 * caller's view: it never throws. On a failed POST the in-flight batch is
 * re-queued (bounded by MAX_QUEUE) so a transient/offline failure isn't lost.
 */
export async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  try {
    const userId = envelopeUserId();
    while (queue.length > 0) {
      const slice = queue.splice(0, BATCH_SIZE);
      const events = slice.map(
        (q) => ({ ...q.body, userId, ts: q.ts }) as AnalyticsEvent,
      );
      try {
        await apiClient.analytics.ingest({ events });
      } catch {
        // Re-queue the unsent batch (front) and stop; the next tick retries.
        queue.unshift(...slice);
        if (queue.length > MAX_QUEUE) queue.splice(MAX_QUEUE);
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

function onAppStateChange(state: AppStateStatus): void {
  // Foregrounding is a natural flush point (and emits app_open below from the
  // app-open hook). Flush on the way to `active`.
  if (state === 'active') void flush();
}

/**
 * Start the batched emitter: an interval flush + a flush-on-foreground listener.
 * Idempotent — safe to call once from the root layout. Returns a stop fn.
 */
export function startAnalytics(): () => void {
  if (intervalHandle === null) {
    intervalHandle = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  }
  if (appStateSub === null) {
    appStateSub = AppState.addEventListener('change', onAppStateChange);
  }
  return stopAnalytics;
}

/** Stop the emitter (flushes a final batch). Used on teardown / tests. */
export function stopAnalytics(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (appStateSub !== null) {
    appStateSub.remove();
    appStateSub = null;
  }
  void flush();
}

/** Test/diagnostic: how many events are queued (not yet flushed). */
export function queuedCount(): number {
  return queue.length;
}

/* --------------------------- typed track helpers --------------------------- */
/* Each enqueues the exact §12 event for a user action. Call sites pass ids /    */
/* counts / enums ONLY — a content field is impossible at compile time, and the  */
/* server's strict ingest firewall would drop one anyway.                        */

/** app_open — fired on app start + each foreground. (No §12 props.) */
export function trackAppOpen(): void {
  enqueue({ event: 'dau' });
}

/**
 * montage_generate_tapped — the user tapped "Create montage". §12's closest
 * content-free engagement signal is `montage_generated` (theme + music + item
 * count); we emit it at tap time with the chosen params (all enums/ids/counts).
 */
export function trackMontageGenerateTapped(args: {
  theme: Theme;
  musicId: string;
  itemCount: number;
}): void {
  enqueue({
    event: 'montage_generated',
    theme: args.theme,
    musicId: args.musicId,
    itemCount: args.itemCount,
  });
}

/** montage_published — on a successful publish (montage id + group count). */
export function trackMontagePublished(args: {
  montageId: string;
  groupCount: number;
}): void {
  enqueue({
    event: 'montage_published',
    montageId: args.montageId,
    groupCount: args.groupCount,
  });
}

/** reaction_sent — on a reaction upsert (montage id + reaction enum ONLY). */
export function trackReactionSent(args: {
  montageId: string;
  reactionType: ReactionType;
}): void {
  enqueue({
    event: 'reaction_sent',
    montageId: args.montageId,
    reactionType: args.reactionType,
  });
}

/** comment_sent — on a comment create (montage id ONLY; NEVER the text). */
export function trackCommentSent(args: { montageId: string }): void {
  enqueue({ event: 'comment_sent', montageId: args.montageId });
}

/** feed_viewed — on opening the feed (optional group id). */
export function trackFeedViewed(args: { groupId?: string } = {}): void {
  enqueue({
    event: 'feed_viewed',
    ...(args.groupId ? { groupId: args.groupId } : {}),
  });
}

/** media_added — on a media item added to today (media-type enum + count). */
export function trackMediaAdded(args: {
  mediaType: MediaType;
  dayItemCount?: number;
}): void {
  enqueue({
    event: 'media_added',
    mediaType: args.mediaType,
    ...(args.dayItemCount !== undefined ? { dayItemCount: args.dayItemCount } : {}),
  });
}

export type { AnalyticsEventName };
