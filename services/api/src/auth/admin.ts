/**
 * Admin authorization — `requireAdmin` preHandler (Slice 8 §8 admin surface).
 *
 * Gates every `/admin/*` route on:
 *   1. a VALID, ACTIVE session (same checks as `requireSession`: a missing/invalid
 *      session → 401; a suspended/banned/deleted account → 403 suspended/banned /
 *      401 gone — an admin who is later suspended is locked out too), AND
 *   2. `user.is_admin === true` (seeded from the ADMIN_EMAILS allowlist on sign-in,
 *      see auth/betterAuth.ts session-create hook).
 *
 * A valid NON-ADMIN session → 403 forbidden, and the attempt is AUDITED
 * (`admin_access_denied` tombstone, actor = the rejected user, content-free) so a
 * probe of the admin surface leaves a trail. A request with no session is a plain
 * 401 (no actor to audit). On success it attaches `req.user`/`req.session` exactly
 * like `requireSession`, so admin handlers read the principal the same way.
 *
 * `is_admin` is a server-only column: it is never set through any public endpoint;
 * the only writer is the sign-in allowlist seed. So this guard cannot be bypassed
 * by a self-service profile write.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { errors } from '@twenty4/contracts/errors';

import { resolveSession } from './middleware.js';
import { writeAuditTombstone } from '../lib/audit.js';

export const requireAdmin: preHandlerHookHandler = async (
  req: FastifyRequest,
  _reply: FastifyReply,
) => {
  const resolved = await resolveSession(req);
  // No/invalid session → 401 (no actor to audit).
  if (!resolved) throw errors.unauthorized('Authentication required');

  const { user, session } = resolved;

  // Reject non-active accounts BEFORE the admin check — a suspended/banned/deleted
  // account (even one flagged is_admin) must not reach the admin surface.
  switch (user.accountStatus) {
    case 'suspended':
      throw errors.suspended('Account suspended');
    case 'banned':
      throw errors.banned('Account banned');
    case 'deleted':
      throw errors.unauthorized('Account no longer exists');
    case 'active':
      break;
    default:
      throw errors.unauthorized('Authentication required');
  }

  // A valid, active, NON-admin session → 403 forbidden + audit the attempt.
  if (!user.isAdmin) {
    // Best-effort audit (never block the 403 on an audit-write failure).
    try {
      await writeAuditTombstone({
        actorId: user.id,
        action: 'admin_access_denied',
        targetType: 'user',
        targetId: user.id,
        metadata: { method: req.method, path: sanitizePath(req.url) },
      });
    } catch {
      /* audit is best-effort; the 403 still stands */
    }
    throw errors.forbidden('admin access required');
  }

  req.user = user;
  req.session = session;
};

/**
 * Reduce a request URL to a content-free, code-like token (strip the query string
 * and any uuid segments, then join with '.') so the audit metadata stays non-PII
 * AND survives the tombstone content firewall, which only keeps short tokens of
 * `[A-Za-z0-9_.:-]` (no '/'). e.g. `/admin/users/<uuid>/ban?x=1` →
 * `admin.users._.ban`.
 */
function sanitizePath(url: string): string {
  const path = url.split('?')[0] ?? url;
  return path
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
        ? '_'
        : seg,
    )
    .join('.')
    .slice(0, 64);
}
