/**
 * auth façade module (§8 Auth & onboarding).
 *
 * Thin twenty4-shaped endpoints on top of Better Auth's server API
 * (`auth.api.*`). The contracts DTOs (dto/auth.ts) are the wire shape; Better
 * Auth owns the actual session/token/OTP storage in Postgres.
 *
 *   POST /auth/start         → begin email/phone OTP (or social entry; stubbed)
 *   POST /auth/verify        → submit OTP → issue a session (bearer token)
 *   POST /auth/refresh       → re-validate the current session, return fresh token
 *   POST /auth/logout        → revoke the current session
 *   GET  /auth/dev/last-otp  → DEV-ONLY: read back the latest OTP for an identifier
 *
 * NOTE: Better Auth's own routes (e.g. /auth/sign-in/email-otp) are mounted by a
 * catch-all in auth/handler.ts; these façade routes are registered BEFORE it so
 * they win for these exact paths.
 */
import type { FastifyPluginAsync } from 'fastify';
import {
  authStartRequestSchema,
  authStartResponseSchema,
  authVerifyRequestSchema,
  sessionTokensSchema,
  type SessionTokens,
} from '@twenty4/contracts/dto';
import { eq } from 'drizzle-orm';
import { users } from '@twenty4/contracts/db';
import { errors } from '@twenty4/contracts/errors';

import { auth } from '../../auth/betterAuth.js';
import { resolveSession, toWebHeaders } from '../../auth/middleware.js';
import { readDevOtp } from '../../auth/otpTransport.js';
import { isSocialProviderStubbed } from '../../auth/socialProviders.js';
import { redis } from '../../redis/index.js';
import { db } from '../../db/index.js';
import { env } from '../../env.js';

/** Redis key for an OTP challenge → identifier+method mapping. */
const challengeKey = (id: string): string => `auth:challenge:${id}`;
const CHALLENGE_TTL = 600; // 10 min, matches OTP expiry.

interface Challenge {
  method: 'phone' | 'email';
  identifier: string;
}

async function ensureRedis(): Promise<void> {
  if (
    redis.status === 'wait' ||
    redis.status === 'close' ||
    redis.status === 'end'
  ) {
    await redis.connect();
  }
}

/** Extract the bearer session token Better Auth sets after a sign-in. */
function tokenFromHeaders(headers: Headers): string | null {
  return headers.get('set-auth-token');
}

export const authModule: FastifyPluginAsync = async (app) => {
  // ---- POST /auth/start ----------------------------------------------------
  app.post('/start', async (req, reply) => {
    const body = authStartRequestSchema.parse(req.body);

    // Social entry (apple/google): stubbed. Return the OAuth authorize URL once
    // real credentials exist; until then, signal not-implemented clearly.
    if (body.method === 'apple' || body.method === 'google') {
      if (isSocialProviderStubbed(body.method)) {
        // 501-style: configured-but-stub. Use a typed conflict so the client can
        // show "coming soon" without crashing.
        throw errors.conflict(
          `${body.method} sign-in is configured but not yet enabled (stub)`,
          { provider: body.method, stub: true },
        );
      }
      // Real social path would mint an authorize URL here (Better Auth social).
      // TODO(social): return auth.api.signInSocial({ provider }) authorize URL.
      throw errors.conflict('social sign-in not wired', { provider: body.method });
    }

    if (!body.identifier) {
      throw errors.validation('identifier is required for phone/email');
    }

    // Send a REAL sign-in OTP via Better Auth (transport logs + caches in dev).
    if (body.method === 'email') {
      await auth.api.sendVerificationOTP({
        body: { email: body.identifier, type: 'sign-in' },
        headers: toWebHeaders(req),
      });
    } else {
      // phone
      await auth.api.sendPhoneNumberOTP({
        body: { phoneNumber: body.identifier },
        headers: toWebHeaders(req),
      });
    }

    // Mint a challenge id pairing verify → identifier+method.
    const challengeId = crypto.randomUUID();
    await ensureRedis();
    await redis.set(
      challengeKey(challengeId),
      JSON.stringify({ method: body.method, identifier: body.identifier } satisfies Challenge),
      'EX',
      CHALLENGE_TTL,
    );

    reply.code(200);
    return authStartResponseSchema.parse({ challengeId, authenticated: false });
  });

  // ---- POST /auth/verify ---------------------------------------------------
  app.post('/verify', async (req, reply) => {
    const body = authVerifyRequestSchema.parse(req.body);

    await ensureRedis();
    const raw = await redis.get(challengeKey(body.challengeId));
    if (!raw) throw errors.unauthorized('challenge expired or invalid');
    const challenge = JSON.parse(raw) as Challenge;

    let token: string | null = null;
    let isNewUser = false;

    if (challenge.method === 'email') {
      const { headers, response } = await auth.api.signInEmailOTP({
        body: { email: challenge.identifier, otp: body.code },
        returnHeaders: true,
      });
      token = tokenFromHeaders(headers);
      isNewUser = Boolean((response as { isRegistration?: boolean })?.isRegistration);
    } else {
      const { headers, response } = await auth.api.verifyPhoneNumber({
        body: { phoneNumber: challenge.identifier, code: body.code },
        returnHeaders: true,
      });
      token = tokenFromHeaders(headers);
      isNewUser = Boolean((response as { isRegistration?: boolean })?.isRegistration);
    }

    if (!token) throw errors.unauthorized('invalid or expired code');

    // Stamp auth_provider on first sign-in (it carries a DB default of 'email').
    const session = await auth.api.getSession({
      headers: bearerHeaders(token),
    });
    if (!session?.user) throw errors.unauthorized('session not established');

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    if (user && challenge.method === 'phone' && user.authProvider !== 'phone') {
      await db
        .update(users)
        .set({ authProvider: 'phone' })
        .where(eq(users.id, user.id));
    }

    // needsProfile when the username hasn't been chosen yet (profile-setup 1.4).
    const needsProfile = !user?.username || isNewUser;

    // Challenge consumed.
    await redis.del(challengeKey(body.challengeId));

    const tokens: SessionTokens = {
      accessToken: token,
      // Better Auth uses a single opaque session token (no separate refresh token);
      // we expose the same token as refresh for the contract's shape, and /refresh
      // re-validates it.
      refreshToken: token,
      expiresAt: session.session
        ? new Date(session.session.expiresAt).getTime()
        : Date.now() + 1000 * 60 * 60 * 24 * 30,
      needsProfile,
      provider: challenge.method,
    };
    reply.code(200);
    return sessionTokensSchema.parse(tokens);
  });

  // ---- POST /auth/refresh --------------------------------------------------
  app.post('/refresh', async (req, reply) => {
    const resolved = await resolveSession(req);
    if (!resolved) throw errors.unauthorized('no active session');

    const tokens: SessionTokens = {
      accessToken: resolved.session.token,
      refreshToken: resolved.session.token,
      expiresAt: resolved.session.expiresAt.getTime(),
      needsProfile: !resolved.user.username,
      provider: resolved.user.authProvider,
    };
    reply.code(200);
    return sessionTokensSchema.parse(tokens);
  });

  // ---- POST /auth/logout ---------------------------------------------------
  app.post('/logout', async (req, reply) => {
    // Revoke the current session (deletes the row → immediate revocation).
    try {
      await auth.api.signOut({ headers: toWebHeaders(req) });
    } catch {
      // Idempotent: already-gone session is a successful logout.
    }
    reply.code(204).send();
  });

  // ---- GET /auth/dev/last-otp (DEV ONLY) -----------------------------------
  if (env.NODE_ENV !== 'production') {
    app.get('/dev/last-otp', async (req, reply) => {
      const identifier = (req.query as { identifier?: string }).identifier;
      if (!identifier) throw errors.validation('identifier query param required');
      const code = await readDevOtp(identifier);
      if (!code) throw errors.notFound('no OTP cached for identifier');
      reply.code(200);
      return { identifier, code };
    });
  }
};

/** Build a Headers object carrying a bearer token (for server-side getSession). */
function bearerHeaders(token: string): Headers {
  const h = new Headers();
  h.set('authorization', `Bearer ${token}`);
  return h;
}
