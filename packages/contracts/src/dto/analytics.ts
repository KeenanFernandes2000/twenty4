/**
 * Analytics DTOs (§12 + PLAN slice 9) — the ingest request + the admin readout.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ The ingest request is a BATCH of §12 events validated EACH against the      │
 * │ STRICT discriminated union in `../analytics.ts` (ids/counts/enums ONLY). An │
 * │ event with an unknown `event` or ANY extra/free-text field fails the strict │
 * │ parse — the privacy firewall. The admin readout is COUNTS ONLY (no ids/     │
 * │ content): per-(event_type, day[, dimension]) aggregate counters.            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
import { z } from 'zod';
import { analyticsEventSchema, analyticsEventNameSchema } from '../analytics.js';

/* -------------------------------- ingest ----------------------------------- */

/** Max events accepted in one ingest batch (bound the request + work per call). */
export const ANALYTICS_BATCH_MAX = 100;

/**
 * POST /analytics body — a batch of §12 events. Each element is validated against
 * the STRICT `analyticsEventSchema` (unknown type or extra field → reject). The
 * server stamps the day + the caller's user id; client-sent `userId`/`ts` on the
 * envelope are accepted (they're ids/timestamps, never content) but the day bucket
 * for aggregation is SERVER-derived, not trusted from the client.
 */
export const analyticsIngestRequestSchema = z
  .object({
    events: z.array(analyticsEventSchema).min(1).max(ANALYTICS_BATCH_MAX),
  })
  .strict();
export type AnalyticsIngestRequest = z.infer<typeof analyticsIngestRequestSchema>;

/** Response: how many events were accepted (validated + counted) vs dropped. */
export const analyticsIngestResponseSchema = z
  .object({
    accepted: z.number().int().min(0),
    dropped: z.number().int().min(0),
  })
  .strict();
export type AnalyticsIngestResponse = z.infer<typeof analyticsIngestResponseSchema>;

/* ----------------------------- admin readout ------------------------------- */

/** A single aggregate counter row (counts only — no ids, no content). */
export const analyticsAggregateRowSchema = z
  .object({
    eventType: analyticsEventNameSchema,
    /** UTC day (YYYY-MM-DD). */
    day: z.string(),
    /** Content-free breakdown key (enum value) or '' when none. */
    dimension: z.string(),
    count: z.number().int().min(0),
  })
  .strict();
export type AnalyticsAggregateRow = z.infer<typeof analyticsAggregateRowSchema>;

/** GET /admin/analytics — the aggregate rollups (counts only) for the ops dashboard. */
export const adminAnalyticsResponseSchema = z
  .object({
    /** Inclusive UTC day range covered (YYYY-MM-DD), echoing the query window. */
    since: z.string(),
    until: z.string(),
    /** Per-(event_type, day, dimension) counters. */
    rows: z.array(analyticsAggregateRowSchema),
    /** Convenience totals per event_type over the window (counts only). */
    totals: z.array(
      z
        .object({
          eventType: analyticsEventNameSchema,
          count: z.number().int().min(0),
        })
        .strict(),
    ),
  })
  .strict();
export type AdminAnalyticsResponse = z.infer<typeof adminAnalyticsResponseSchema>;
