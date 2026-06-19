/**
 * analytics/emit.ts (PLAN slice 9 / §3 analytics/emit) — server-side §12 emission.
 *
 * The API's half of analytics emission. Mirrors the worker's `emitAnalytics`
 * pattern (services/worker/src/lib/analytics.ts) but funnels through the SAME
 * privacy firewall + the aggregate writer, so a server-emitted event is held to
 * the identical no-content invariant as a client-ingested one:
 *
 *   emit(event) → sanitizeEvent (STRICT §12 parse) → toAggregateKey
 *               → incrementAggregate (per (event_type, day, dimension) counter)
 *
 * FIRE-AND-FORGET: analytics must NEVER break or slow a user flow. `emit` is sync
 * (returns void) and swallows/logs errors internally — a failed counter write is
 * not allowed to fail a publish/react/comment. A test sink (`drainEmitted`) lets
 * the suite assert WHICH events were emitted + prove none carried content.
 *
 * Convenience emitters (`emitMontagePublished`, …) build the typed event so call
 * sites stay terse and can't accidentally smuggle an off-schema field (the strict
 * parse would drop it anyway, but the typed builder catches it at compile time).
 */
import type {
  AnalyticsEvent,
  AnalyticsEventName,
} from '@twenty4/contracts/analytics';
import type { Theme, ReactionType, MediaType } from '@twenty4/contracts/enums';

import { sanitizeEvent, toAggregateKey } from './firewall.js';
import { incrementAggregate } from './aggregate.js';

/**
 * In-memory ring of the LAST emitted (firewall-cleared) events — the test
 * assertion surface (production swaps for the real [TEAM] vendor sink). Bounded so
 * a long-running API process can't grow it unbounded. Only CLEAN events land here,
 * so even the test buffer can't hold content.
 */
const MAX_BUFFER = 500;
const buffer: AnalyticsEvent[] = [];

/** Drain (and clear) the emitted-event buffer — used by the analytics test to assert. */
export function drainEmitted(): AnalyticsEvent[] {
  const out = buffer.slice();
  buffer.length = 0;
  return out;
}

/**
 * Emit ONE server-side §12 event. Runs it through the strict firewall, records the
 * clean event in the test buffer, and increments the matching aggregate counter.
 * Fire-and-forget: never throws into the caller; a failed write is logged, not
 * surfaced. Returns immediately (the counter write is scheduled, not awaited).
 */
export function emit(event: AnalyticsEvent): void {
  // Strict firewall — a bad/off-schema event is DROPPED (never counted/buffered).
  const clean = sanitizeEvent(event);
  if (!clean) return;

  buffer.push(clean);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);

  // Persist as an anonymized aggregate increment. Fire-and-forget: swallow errors
  // so analytics can never break the user flow that emitted it.
  void incrementAggregate(toAggregateKey(clean)).catch(() => {
    /* best-effort: a dropped analytics increment must not affect the request */
  });
}

/** Current ms-epoch timestamp for the §12 envelope. */
function now(): number {
  return Date.now();
}

/* --------------------------- typed convenience emitters -------------------- */
/* Each builds the exact §12 event for a server flow. Call sites pass ids/counts/   */
/* enums ONLY — the types make a content field impossible at compile time, and the  */
/* strict firewall would drop it anyway.                                            */

/** montage_generated — on generate/regenerate (theme + music + item count). */
export function emitMontageGenerated(args: {
  userId: string;
  theme: Theme;
  musicId: string;
  itemCount: number;
}): void {
  emit({
    event: 'montage_generated',
    userId: args.userId,
    ts: now(),
    theme: args.theme,
    musicId: args.musicId,
    itemCount: args.itemCount,
  });
}

/** montage_published — on publish (with the group count it was published to). */
export function emitMontagePublished(args: {
  userId: string;
  montageId: string;
  groupCount: number;
}): void {
  emit({
    event: 'montage_published',
    userId: args.userId,
    ts: now(),
    montageId: args.montageId,
    groupCount: args.groupCount,
  });
}

/** reaction_sent — on a reaction upsert (montage id + reaction enum). */
export function emitReactionSent(args: {
  userId: string;
  montageId: string;
  reactionType: ReactionType;
}): void {
  emit({
    event: 'reaction_sent',
    userId: args.userId,
    ts: now(),
    montageId: args.montageId,
    reactionType: args.reactionType,
  });
}

/** comment_sent — on a comment create (montage id ONLY; NEVER the comment text). */
export function emitCommentSent(args: { userId: string; montageId: string }): void {
  emit({
    event: 'comment_sent',
    userId: args.userId,
    ts: now(),
    montageId: args.montageId,
  });
}

/** feed_viewed — on a feed read (optional group id). */
export function emitFeedViewed(args: { userId: string; groupId?: string }): void {
  emit({
    event: 'feed_viewed',
    userId: args.userId,
    ts: now(),
    ...(args.groupId ? { groupId: args.groupId } : {}),
  });
}

/** media_added — on a media item completing upload (media-type enum). */
export function emitMediaAdded(args: {
  userId: string;
  mediaType: MediaType;
  dayItemCount?: number;
}): void {
  emit({
    event: 'media_added',
    userId: args.userId,
    ts: now(),
    mediaType: args.mediaType,
    ...(args.dayItemCount !== undefined ? { dayItemCount: args.dayItemCount } : {}),
  });
}

/**
 * account_deleted — on DELETE /users/me. §12 has no dedicated `account_deleted`
 * event name in the closed set; the nearest content-free operational signal is a
 * `cleanup_job_result` for the account-deletion request (ok=true). The worker's
 * `purge-account` job emits the real purge-completion aggregate; this records the
 * user-initiated request itself. (Kept as `cleanup_job_result` so it stays inside
 * the closed §12 union — no schema drift.)
 */
export function emitAccountDeletionRequested(args: { userId: string }): void {
  emit({
    event: 'cleanup_job_result',
    userId: args.userId,
    ts: now(),
    job: 'account-deletion-requested',
    ok: true,
  });
}

export type { AnalyticsEventName };
