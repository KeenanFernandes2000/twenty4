/**
 * Worker-side §12 analytics emit — the DELETION-LIFECYCLE half.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ HARD INVARIANT (§12 + §6): events carry NO USER CONTENT.                   │
 * │ Every payload is validated against `analyticsEventSchema` (a STRICT Zod    │
 * │ discriminated union of ids/counts/enums/durations only) BEFORE it leaves   │
 * │ this module. A stray free-text/content field fails `.parse()` and throws — │
 * │ so a content leak can never be emitted. The deletion suite asserts this.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The vendor sink is [TEAM]; here we validate + buffer the events. Tests read the
 * buffer (`drainAnalytics`) to PROVE the no-content invariant on real deletions.
 */
import {
  analyticsEventSchema,
  type AnalyticsEvent,
} from '@twenty4/contracts/analytics';

/**
 * In-memory ring of the LAST emitted events. Production swaps this for the real
 * vendor sink; in Phase-1 (and the deletion suite) it's the assertion surface.
 * Bounded so a long-running worker can't grow it unbounded.
 */
const MAX_BUFFER = 500;
const buffer: AnalyticsEvent[] = [];

/**
 * Validate + emit a §12 analytics event. The STRICT schema rejects any property
 * not in the closed §12 shape (so no content/PII can ride along) — a bad event
 * throws here rather than silently leaking. Returns the parsed (clean) event.
 */
export function emitAnalytics(event: AnalyticsEvent): AnalyticsEvent {
  // `.parse` (strict) is the content firewall: only ids/counts/enums survive.
  const clean = analyticsEventSchema.parse(event);
  buffer.push(clean);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  // TODO(prod): forward `clean` to the [TEAM] analytics vendor here.
  return clean;
}

/** Drain (and clear) the buffered events — used by the deletion suite to assert. */
export function drainAnalytics(): AnalyticsEvent[] {
  const out = buffer.slice();
  buffer.length = 0;
  return out;
}

/** System user id stand-in for analytics events fired by background jobs. */
export const SYSTEM_ACTOR = 'system';
