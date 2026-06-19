/**
 * Auth middleware — `requireSession` preHandler.
 *
 * Validates the Better Auth session (cookie OR `Authorization: Bearer <token>`),
 * loads the twenty4 user row, and REJECTS suspended/banned/deleted accounts with
 * the proper @twenty4/contracts error codes. On success it attaches `req.user`
 * and `req.session` for downstream handlers.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { eq } from 'drizzle-orm';
import { users, type User } from '@twenty4/contracts/db';
import { errors } from '@twenty4/contracts/errors';

import { auth } from './betterAuth.js';
import { db } from '../db/index.js';

/** The validated session info attached to the request. */
export interface RequestSession {
  /** Better Auth session id. */
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
}

// Augment Fastify's request with the authenticated principal.
declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    session?: RequestSession;
  }
}

/**
 * Convert Fastify's incoming headers into a Web `Headers` object that
 * Better Auth's `auth.api.*` calls expect.
 */
export function toWebHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.append(key, String(value));
    }
  }
  return headers;
}

/**
 * Resolve the current user from a request, or return null if unauthenticated.
 * Does NOT throw on account-status — callers decide (requireSession enforces).
 */
export async function resolveSession(
  req: FastifyRequest,
): Promise<{ user: User; session: RequestSession } | null> {
  const result = await auth.api.getSession({ headers: toWebHeaders(req) });
  if (!result?.session || !result.user) return null;

  // Re-load the canonical user row (Better Auth's projected user omits some cols).
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, result.session.userId))
    .limit(1);
  if (!user) return null;

  const session: RequestSession = {
    id: result.session.id,
    token: result.session.token,
    userId: result.session.userId,
    expiresAt: new Date(result.session.expiresAt),
  };
  return { user, session };
}

/**
 * preHandler: require a valid, non-suspended/banned/deleted session.
 *   - no/invalid session            → 401 unauthorized
 *   - account_status === suspended  → 403 suspended  (→ 7.5 gate)
 *   - account_status === banned     → 403 banned
 *   - account_status === deleted    → 401 unauthorized (treat as gone)
 */
export const requireSession: preHandlerHookHandler = async (
  req: FastifyRequest,
  _reply: FastifyReply,
) => {
  const resolved = await resolveSession(req);
  if (!resolved) throw errors.unauthorized('Authentication required');

  const { user, session } = resolved;

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

  req.user = user;
  req.session = session;
};
