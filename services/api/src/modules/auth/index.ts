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
import {
  throttleOtpSend,
  consumeVerifyBudget,
  clearVerifyBudget,
} from '../../lib/rateLimit.js';

/**
 * Translate a Better Auth APIError thrown by the session-create databaseHook
 * (ACCOUNT_SUSPENDED / ACCOUNT_BANNED / ACCOUNT_DELETED) into the precise
 * twenty4 contract error. Returns the mapped ApiError, or null if not one of
 * ours (caller re-throws the original / treats as bad code).
 */
function mapBlockedSignin(err: unknown): ReturnType<typeof errors.banned> | null {
  const code = (err as { body?: { code?: string } })?.body?.code;
  switch (code) {
    case 'ACCOUNT_SUSPENDED':
      return errors.suspended('Account suspended');
    case 'ACCOUNT_BANNED':
      return errors.banned('Account banned');
    case 'ACCOUNT_DELETED':
      return errors.unauthorized('Account no longer exists');
    default:
      return null;
  }
}

/**
 * RAW Better Auth OTP send/verify/session-mint HTTP endpoints we DENY to
 * external callers (scope-relative to the /auth prefix). Enumerated from the
 * live BA 1.6 instance (emailOTP + phoneNumber plugins). The ONLY public way to
 * send/verify an OTP is POST /auth/start + POST /auth/verify, which enforce the
 * per-identifier OTP-send throttle and the cross-reissue verify-attempt budget.
 *
 * Denying these here (Fastify route layer) does NOT affect the façade's
 * in-process `auth.api.*` calls (those never hit the Fastify router). See the
 * deny-loop comment below for why this MUST NOT move to the BA `hooks.before`.
 */
const DENIED_RAW_OTP_PATHS = [
  // --- email OTP: send + verify + check ---
  '/email-otp/send-verification-otp', // sends an OTP (sign-in / email-verification / forget-password)
  '/sign-in/email-otp', // verifies OTP → mints a session
  '/email-otp/verify-email', // verifies OTP (email-verification)
  '/email-otp/check-verification-otp', // verifies OTP without consuming
  // --- email OTP: change-email variants (send/verify OTP via the same transport) ---
  '/email-otp/request-email-change', // sends an OTP (inert today: change-email disabled, denied defense-in-depth)
  '/email-otp/change-email', // verifies the change-email OTP (inert today, locked shut)
  // --- email OTP: password-reset variants (also send/verify OTP) ---
  '/forget-password/email-otp', // sends a reset OTP
  '/email-otp/request-password-reset', // sends a reset OTP
  '/email-otp/reset-password', // verifies the reset OTP
  // --- phone OTP: send + verify ---
  '/phone-number/send-otp', // sends an OTP
  '/phone-number/verify', // verifies OTP → mints a session
  '/sign-in/phone-number', // phone credential sign-in (session-mint surface)
  // --- phone OTP: password-reset variants ---
  '/phone-number/request-password-reset', // sends a reset OTP
  '/phone-number/reset-password', // verifies the reset OTP
  // --- credential sign-in/sign-up surfaces (password disabled, denied DiD) ---
  '/sign-in/email', // email+password sign-in (disabled, but locked shut)
  '/sign-up/email', // email+password sign-up (disabled, but locked shut)
] as const;

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
  // Per-IP HTTP limiter (defense-in-depth; the per-identifier + per-IP Redis
  // counters in throttleOtpSend are the hard guarantee). Generous so the
  // identifier/IP counters are what actually bite first.
  app.post('/start', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
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

    // Throttle OTP sends per-identifier AND per-IP (≤5 / 10min each) BEFORE we
    // ask Better Auth to mint+send a code. Exceeding → 429 rate_limited. This
    // also prevents using re-issue to spam codes / enumerate.
    await throttleOtpSend({ identifier: body.identifier, ip: req.ip });

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
  // Per-IP HTTP limiter (defense-in-depth). The per-IDENTIFIER verify-attempt
  // budget in consumeVerifyBudget is the cross-reissue hard guarantee.
  app.post('/verify', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const body = authVerifyRequestSchema.parse(req.body);

    await ensureRedis();
    const raw = await redis.get(challengeKey(body.challengeId));
    if (!raw) throw errors.unauthorized('challenge expired or invalid');
    const challenge = JSON.parse(raw) as Challenge;

    // Enforce + record the per-identifier verify-attempt budget (≤5 / 10min)
    // BEFORE attempting. The counter is keyed on the IDENTIFIER, not the code or
    // challenge, so re-calling /auth/start (re-issuing an OTP) does NOT reset it
    // → closes the brute-force-reset-via-reissue hole. Throws 429 when exceeded.
    await consumeVerifyBudget(challenge.identifier);

    let token: string | null = null;
    let isNewUser = false;

    try {
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
    } catch (err) {
      // A suspended/banned/deleted account is blocked at session-create by the
      // databaseHook → translate into the precise contract error so a blocked
      // account can NEVER complete verify to mint a new session.
      const mapped = mapBlockedSignin(err);
      if (mapped) throw mapped;
      throw err;
    }

    if (!token) throw errors.unauthorized('invalid or expired code');

    // Genuine success → reset the verify-attempt budget for this identifier.
    await clearVerifyBudget(challenge.identifier);

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

  // ---- Deny Better Auth's user-mutation endpoints --------------------------
  // These façade routes are registered BEFORE the Better Auth catch-all (same
  // scope) so they WIN for these exact paths. Profile writes (display_name /
  // profile_photo_url) must go through the validated PATCH /users/me ONLY; the
  // raw BA endpoints would write unvalidated name/image and could store a value
  // that bricks GET /users/me. We hard-deny here (defense-in-depth with the BA
  // `hooks.before` guard in betterAuth.ts).
  for (const path of ['/update-user', '/delete-user', '/change-email']) {
    app.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: path,
      handler: async () => {
        throw errors.forbidden('endpoint disabled; use PATCH /users/me');
      },
    });
  }

  // ---- Deny Better Auth's RAW OTP send/verify/session-mint endpoints --------
  // SECURITY (adversarial finding): the per-identifier OTP-send throttle and the
  // cross-reissue verify-attempt budget live ONLY on POST /auth/start + /verify.
  // Better Auth's native OTP HTTP routes bypass ALL of it (its per-OTP attempt
  // cap RESETS on every re-issue, and its in-memory limiter is X-Forwarded-For
  // spoofable). An attacker hitting the raw routes directly could brute-force or
  // spam OTPs. We register exact-path façade deny routes BEFORE the BA catch-all
  // (same scope ⇒ they win precedence) returning 403 forbidden.
  //
  // CRITICAL: this denial is done ONLY at the Fastify route layer — NOT in the
  // BA `hooks.before` in betterAuth.ts. The façade drives these SAME BA endpoints
  // IN-PROCESS via `auth.api.sendVerificationOTP` / `signInEmailOTP` /
  // `sendPhoneNumberOTP` / `verifyPhoneNumber`, which run through `hooks.before`
  // with the same `ctx.path`. Denying at the BA-hook layer would therefore block
  // the façade's own internal calls and brick the only legitimate OTP path. The
  // Fastify route layer is reached by EXTERNAL HTTP callers only; the in-process
  // `auth.api.*` calls never touch the Fastify router, so they stay unaffected.
  //
  // Paths are scope-relative (this module is mounted under the /auth prefix) and
  // were enumerated from the live Better Auth 1.6 instance (auth.api endpoint
  // metadata) — emailOTP + phoneNumber plugins, every OTP send/verify + every
  // OTP-backed reset variant + the credential sign-in/sign-up surfaces.
  for (const path of DENIED_RAW_OTP_PATHS) {
    app.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: path,
      handler: async () => {
        throw errors.forbidden(
          'endpoint disabled; use POST /auth/start + POST /auth/verify',
        );
      },
    });
  }

  // ---- POST /auth/refresh --------------------------------------------------
  app.post('/refresh', async (req, reply) => {
    const resolved = await resolveSession(req);
    if (!resolved) throw errors.unauthorized('no active session');

    // Re-check account status BEFORE returning fresh tokens (same gate as
    // requireSession): a suspended/banned/deleted account must NOT be able to
    // refresh into a fresh, usable token even with an otherwise-valid session.
    switch (resolved.user.accountStatus) {
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
