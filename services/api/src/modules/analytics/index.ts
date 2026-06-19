/**
 * analytics module (§12 + PLAN slice 9) — the client-event INGEST FIREWALL.
 *
 * Mounted at /analytics. ONE route:
 *
 *   POST /analytics  {events: [...]}   requireSession · rate-limited · batched
 *
 * THE PRIVACY-CRITICAL FIREWALL (§12 + §6 Q6): every submitted event is validated
 * EACH against the STRICT §12 discriminated union (`analyticsEventSchema`, which is
 * built from `.strict()` object schemas). An event with an UNKNOWN `event` type, or
 * ANY extra / free-text property (a comment text, a caption, a name…), FAILS the
 * strict parse and is DROPPED — it is never stored, never logged. Surviving events
 * are reduced to a content-free `(event_type, day, dimension)` tuple and folded into
 * the `analytics_aggregate` counters. NO per-event row with a user id is written; NO
 * user content can persist. The endpoint reports {accepted, dropped} so a client can
 * see whether its batch validated (but the server never echoes the rejected fields).
 *
 * Two-tier rejection semantics:
 *   - a body that isn't even a well-formed batch (not `{events:[…]}`, empty, too
 *     large, or an element that is the WRONG SHAPE for the discriminated union — no
 *     valid `event` discriminator) → the outer `analyticsIngestRequestSchema.parse`
 *     throws ZodError → 422 (the central handler). This is the "unknown event type"
 *     path (an event whose `event` isn't in the §12 enum has no union branch → 422).
 *   - a body that IS a well-formed batch but where SOME elements carry a content/
 *     extra field: those elements fail their per-branch strict parse and are dropped
 *     (counted in `dropped`); the valid ones are still accepted. (Belt-and-braces —
 *     in practice the same strict union rejects them at the outer parse too.)
 */
import type { FastifyPluginAsync } from 'fastify';
import {
  analyticsIngestRequestSchema,
  analyticsIngestResponseSchema,
} from '@twenty4/contracts/dto';

import { requireSession } from '../../auth/middleware.js';
import { throttleAnalyticsIngest } from '../../lib/rateLimit.js';
import { sanitizeEvent, toAggregateKey, type CleanAnalytics } from '../../analytics/firewall.js';
import { incrementAggregates, utcDay } from '../../analytics/aggregate.js';

export const analyticsModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireSession);

  /* -------------------------------- POST /analytics ------------------------- */
  app.post('/', async (req, reply) => {
    const me = req.user!;

    // Rate-limit the ingest batch per user (fails open — telemetry is non-essential).
    await throttleAnalyticsIngest({ userId: me.id });

    // OUTER firewall: the body must be a well-formed batch of §12 events. A bad
    // shape / unknown event type / extra field on ANY element fails this strict
    // parse → ZodError → 422 (central handler). We never read raw fields off it.
    const body = analyticsIngestRequestSchema.parse(req.body);

    // INNER firewall (belt-and-braces): re-run EACH event through the strict
    // schema and drop any that don't survive. (After the outer parse all should
    // survive; this guarantees the property even if the outer schema is ever
    // loosened, and lets us count drops.) Reduce survivors to content-free keys.
    const keys: CleanAnalytics[] = [];
    let dropped = 0;
    for (const ev of body.events) {
      const clean = sanitizeEvent(ev);
      if (!clean) {
        dropped += 1;
        continue;
      }
      keys.push(toAggregateKey(clean));
    }

    // Persist as anonymized aggregate increments only — server-stamped UTC day,
    // NEVER the client `ts`, and NEVER the caller's id (it is discarded here).
    const accepted = await incrementAggregates(keys, utcDay());

    reply.code(202);
    return analyticsIngestResponseSchema.parse({ accepted, dropped });
  });
};
