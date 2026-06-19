/**
 * §12 analytics PRIVACY FIREWALL (PLAN slice 9) — the single choke point every
 * analytics event (client-ingested OR server-emitted) passes through before it can
 * touch the database.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ HARD INVARIANT (§12 + §6 Q6): only anonymized aggregate COUNTS persist.    │
 * │                                                                            │
 * │  1. STRICT VALIDATION — `analyticsEventSchema` is a STRICT (`.strict()`)   │
 * │     discriminated union of the closed §12 event set. An UNKNOWN `event`    │
 * │     type, or ANY extra/free-text property (caption, comment text, name,    │
 * │     email…), fails the parse → the event is DROPPED. Nothing that isn't an │
 * │     id/count/enum/duration/timestamp can even be represented.              │
 * │  2. AGGREGATION KEY — we then DISCARD the event entirely and keep only a   │
 * │     `(eventType, dimension)` tuple, where `dimension` is a content-free,   │
 * │     LOW-CARDINALITY token (theme / reaction type / media type / provider / │
 * │     error code / job name) or '' . Every value is BOUNDED to a known       │
 * │     allow-list (off-list → 'other'), so even fields the schema types as a  │
 * │     free string (provider/errorCode/job) can NEVER carry a raw value. NO   │
 * │     id, NO timestamp-with-precision, NO user content reaches storage.      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * So even a maliciously-crafted ingest body cannot persist content: a field the
 * schema doesn't know about fails strict parse, and the dimension extractor reads
 * only a hand-picked set of fields off the CLEAN event AND bounds each value to a
 * known low-cardinality allow-list (no value-smuggling through a free string).
 */
import {
  analyticsEventSchema,
  type AnalyticsEvent,
  type AnalyticsEventName,
} from '@twenty4/contracts/analytics';
import { AUTH_PROVIDERS, REACTION_TYPES, MEDIA_TYPES, THEMES } from '@twenty4/contracts/enums';
import { ERROR_CODES } from '@twenty4/contracts/errors';

/**
 * Sentinel for a dimension-bearing value that is NOT in its known allow-list. We
 * collapse to this token rather than persisting the raw value, so the smuggling
 * channel (a free-string `provider`/`errorCode`/`job` carrying content/PII) is
 * closed: an off-list value can only ever become 'other', never the raw text.
 */
const OTHER = 'other';

/**
 * The known cleanup/queue job names that may surface as a `cleanup_job_result`
 * dimension. Sourced from every server-side emit site (worker jobs + the API's
 * account-deletion request). NOT pulled from a contracts enum because `job` is a
 * plain string in §12; this explicit set bounds it to a low-cardinality token.
 */
const KNOWN_JOBS = [
  'cleanup-raw',
  'day-close-sweep',
  'purge-account',
  'sweep-expiries',
  'snapshot-purge-sweep',
  'raw-purge-sweep',
  'account-deletion-requested',
] as const;

/** Frozen allow-list sets for O(1) membership checks per dimension-bearing field. */
const PROVIDERS = new Set<string>(AUTH_PROVIDERS);
const REACTIONS = new Set<string>(REACTION_TYPES);
const MEDIA = new Set<string>(MEDIA_TYPES);
const THEMES_SET = new Set<string>(THEMES);
const ERROR_CODES_SET = new Set<string>(ERROR_CODES);
const JOBS = new Set<string>(KNOWN_JOBS);

/**
 * Bound a candidate dimension value to a KNOWN low-cardinality allow-list: return
 * it verbatim ONLY if it is a member of `allowed`, else collapse to 'other'. This
 * is the hard gate that guarantees `analytics_aggregate.dimension` can only ever be
 * a known token — never a raw client/free string (no content/PII smuggling).
 */
function bound(value: string | undefined, allowed: Set<string>): string {
  return value !== undefined && allowed.has(value) ? value : OTHER;
}

/** A firewall-cleared, persist-safe analytics datum: an event name + content-free dimension. */
export interface CleanAnalytics {
  eventType: AnalyticsEventName;
  /** Content-free, low-cardinality enum value (or '' when the event has no breakdown). */
  dimension: string;
}

/**
 * Run one RAW (untrusted) event object through the strict §12 schema. Returns the
 * parsed clean event, or `null` if it fails (unknown type / extra field / bad shape)
 * — i.e. the event is DROPPED, never stored. This is the content firewall: a
 * `.strict()` parse cannot pass a property the closed §12 union doesn't declare.
 */
export function sanitizeEvent(raw: unknown): AnalyticsEvent | null {
  const res = analyticsEventSchema.safeParse(raw);
  return res.success ? res.data : null;
}

/**
 * Extract the persist-safe `(eventType, dimension)` tuple from a CLEAN event.
 *
 * The dimension is doubly constrained: (1) only a deliberately-narrow allow-list of
 * FIELDS is read (theme, reactionType, mediaType, provider, errorCode, job), and
 * (2) each field's VALUE is bounded to a known low-cardinality token set — an
 * off-list value collapses to 'other', never the raw value. It is NEVER an id, a
 * count, a timestamp, or any free text — so the stored aggregate can never be
 * re-personalized or carry content. Anything with no breakdown → ''.
 */
export function toAggregateKey(event: AnalyticsEvent): CleanAnalytics {
  return {
    eventType: event.event,
    dimension: dimensionOf(event),
  };
}

/**
 * Map a clean §12 event to its content-free breakdown dimension, or '' when it has
 * none. Each branch reads ONLY a known dimension field off the already-validated
 * event — never an id, never text — AND bounds its VALUE to a known low-cardinality
 * allow-list (`bound`). The schema validates SHAPE, not the value of free-string
 * fields (`provider`, `errorCode`, `job` are `z.string()`), so without value-bounding
 * a client could smuggle arbitrary text into the dimension. After bounding, the
 * dimension is GUARANTEED to be either '' or a known token (enum value / job name)
 * or the 'other' sentinel — never the raw value.
 */
function dimensionOf(event: AnalyticsEvent): string {
  switch (event.event) {
    case 'montage_generated':
      return bound(event.theme, THEMES_SET); // §12 theme enum
    case 'reaction_sent':
      return bound(event.reactionType, REACTIONS); // §12 reaction enum
    case 'first_media_captured':
    case 'first_media_uploaded':
    case 'media_added':
      return bound(event.mediaType, MEDIA); // §12 media-type enum
    case 'upload_failed':
      // Both optional; prefer the (bounded) error code, else the (bounded) media type.
      if (event.errorCode !== undefined) return bound(event.errorCode, ERROR_CODES_SET);
      if (event.mediaType !== undefined) return bound(event.mediaType, MEDIA);
      return '';
    case 'montage_render_failed':
      return event.errorCode !== undefined ? bound(event.errorCode, ERROR_CODES_SET) : '';
    case 'signup_completed':
      return bound(event.provider, PROVIDERS); // closed auth_provider set
    case 'cleanup_job_result':
      return bound(event.job, JOBS); // a stable, known job name — never free text
    default:
      return '';
  }
}
