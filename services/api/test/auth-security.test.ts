/**
 * Slice 3 auth SECURITY-HARDENING regression suite — exercises the LIVE stack
 * (Postgres + Redis) via app.inject. Each test corresponds to a hardened finding
 * and FAILS against the pre-hardening code:
 *
 *   - account-status enforced on /auth/refresh (suspended/banned/deleted).
 *   - banned/deleted account cannot complete /auth/verify to mint a new session.
 *   - Better Auth /auth/update-user is denied; profile fields unchanged + me 200.
 *   - duplicate username claim returns 409 (not a 500) via the unique-violation
 *     catch (the previously-dead detection path).
 *   - OTP verify is rate-limited PER IDENTIFIER and re-issuing /auth/start does
 *     NOT reset the verify-attempt budget.
 *   - GET /users/me is robust to a pre-existing invalid stored profile photo.
 *
 * Helper `signIn(email)` runs the real start→dev-otp→verify handshake and returns
 * the bearer token + userId. Created rows are cleaned up in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { db, closeDb } from '../src/db/index.js';
import { redis, closeRedis } from '../src/redis/index.js';
import { closeQueues } from '../src/queue/producers.js';
import { closeHttpRateLimit } from '../src/lib/httpRateLimit.js';
import {
  OTP_SEND_BUCKET_ID,
  OTP_SEND_BUCKET_IP,
  VERIFY_ATTEMPT_BUCKET,
  normalizeIdentifier,
} from '../src/lib/rateLimit.js';

const RUN = Date.now();
const createdEmails: string[] = [];

function mkEmail(tag: string): string {
  const e = `sec-${tag}-${RUN}-${Math.floor(Math.random() * 1e6)}@twenty4.test`;
  createdEmails.push(e);
  return e;
}

async function ensureRedis(): Promise<void> {
  if (redis.status === 'wait' || redis.status === 'close' || redis.status === 'end') {
    await redis.connect();
  }
}

/** Clear all rate-limit counters touched by an identifier (test isolation). */
async function resetLimits(identifier: string, ip = '127.0.0.1'): Promise<void> {
  await ensureRedis();
  const id = normalizeIdentifier(identifier);
  await redis.del(`rl:${OTP_SEND_BUCKET_ID}:${id}`);
  await redis.del(`rl:${VERIFY_ATTEMPT_BUCKET}:${id}`);
  await redis.del(`rl:${OTP_SEND_BUCKET_IP}:${ip}`);
}

/**
 * Purge the coarse @fastify/rate-limit per-IP counters (nameSpace 'twenty4-rl:').
 * They key on the test host IP and otherwise persist across vitest runs, poisoning
 * later runs. The hard guarantees live in the lib counters above; this layer is
 * defense-in-depth, so clearing it for the test IP is safe and makes runs
 * deterministic.
 */
async function purgeHttpLimiter(): Promise<void> {
  await ensureRedis();
  const keys = await redis.keys('twenty4-rl:*');
  if (keys.length) await redis.del(...keys);
}

describe('auth security hardening (live DB + redis)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // Start from a clean coarse-limiter slate so prior runs can't poison this one.
    await purgeHttpLimiter();
  });

  afterAll(async () => {
    for (const e of createdEmails) {
      try {
        await db.execute(sql`delete from users where email = ${e}`);
      } catch {
        /* ignore */
      }
    }
    await app.close();
    await Promise.allSettled([closeQueues(), closeRedis(), closeHttpRateLimit(), closeDb()]);
  });

  /** Full real handshake → { token, userId }. */
  async function signIn(email: string): Promise<{ token: string; userId: string }> {
    await resetLimits(email);
    const start = await app.inject({
      method: 'POST',
      url: '/auth/start',
      payload: { method: 'email', identifier: email },
    });
    expect(start.statusCode).toBe(200);
    const challengeId = start.json().challengeId as string;

    const otpRes = await app.inject({
      method: 'GET',
      url: `/auth/dev/last-otp?identifier=${encodeURIComponent(email)}`,
    });
    expect(otpRes.statusCode).toBe(200);
    const code = otpRes.json().code as string;

    const verify = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, code },
    });
    expect(verify.statusCode).toBe(200);
    const token = verify.json().accessToken as string;

    const me = await app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    return { token, userId: me.json().id as string };
  }

  /** Start a fresh OTP for an existing identifier and return { challengeId, code }. */
  async function freshChallenge(email: string): Promise<{ challengeId: string; code: string }> {
    await resetLimits(email);
    const start = await app.inject({
      method: 'POST',
      url: '/auth/start',
      payload: { method: 'email', identifier: email },
    });
    expect(start.statusCode).toBe(200);
    const challengeId = start.json().challengeId as string;
    const otpRes = await app.inject({
      method: 'GET',
      url: `/auth/dev/last-otp?identifier=${encodeURIComponent(email)}`,
    });
    expect(otpRes.statusCode).toBe(200);
    return { challengeId, code: otpRes.json().code as string };
  }

  // --- Finding 2: /auth/refresh enforces account-status -----------------------
  describe('/auth/refresh re-checks account status', () => {
    it('suspended → 403 suspended (not 200)', async () => {
      const email = mkEmail('refresh-susp');
      const { token, userId } = await signIn(email);
      await db.execute(sql`update users set account_status = 'suspended' where id = ${userId}`);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: 'suspended', status: 403 } });
    });

    it('banned → 403 banned (not 200)', async () => {
      const email = mkEmail('refresh-ban');
      const { token, userId } = await signIn(email);
      await db.execute(sql`update users set account_status = 'banned' where id = ${userId}`);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: 'banned', status: 403 } });
    });

    it('deleted → 401 unauthorized (not 200)', async () => {
      const email = mkEmail('refresh-del');
      const { token, userId } = await signIn(email);
      await db.execute(sql`update users set account_status = 'deleted' where id = ${userId}`);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'unauthorized', status: 401 } });
    });

    it('active → 200 (sanity: hardening does not break the happy path)', async () => {
      const email = mkEmail('refresh-ok');
      const { token } = await signIn(email);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().accessToken).toBe('string');
    });
  });

  // --- Finding 3: banned/deleted cannot complete /auth/verify -----------------
  describe('/auth/verify refuses to mint a session for a blocked account', () => {
    it('banned existing user → verify rejected, no token', async () => {
      const email = mkEmail('verify-ban');
      const { userId } = await signIn(email);
      await db.execute(sql`update users set account_status = 'banned' where id = ${userId}`);

      const { challengeId, code } = await freshChallenge(email);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { challengeId, code },
      });
      expect(res.statusCode).not.toBe(200);
      expect(res.json()).toMatchObject({ error: { code: 'banned', status: 403 } });
      expect(res.json().accessToken).toBeUndefined();
    });

    it('deleted existing user → verify rejected, no token', async () => {
      const email = mkEmail('verify-del');
      const { userId } = await signIn(email);
      await db.execute(sql`update users set account_status = 'deleted' where id = ${userId}`);

      const { challengeId, code } = await freshChallenge(email);
      const res = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { challengeId, code },
      });
      expect(res.statusCode).not.toBe(200);
      expect(res.json()).toMatchObject({ error: { code: 'unauthorized', status: 401 } });
      expect(res.json().accessToken).toBeUndefined();
    });
  });

  // --- Finding 4: Better Auth /auth/update-user is denied ---------------------
  describe('Better Auth user-mutation endpoints are blocked', () => {
    it('/auth/update-user cannot store an unvalidated value; me stays 200', async () => {
      const email = mkEmail('upd-user');
      const { token, userId } = await signIn(email);

      // Set a known-good baseline via the validated façade.
      const patch = await app.inject({
        method: 'PATCH',
        url: '/users/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: 'Legit Name', profilePhotoUrl: 'https://cdn.example.com/ok.png' },
      });
      expect(patch.statusCode).toBe(200);

      // Attempt the malicious BA mutation (would write name/image unvalidated).
      const evil = await app.inject({
        method: 'POST',
        url: '/auth/update-user',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { name: 'HACKED', image: 'not-a-valid-url::::' },
      });
      // Blocked — façade wins (forbidden) or BA hook denies; never 200.
      expect(evil.statusCode).not.toBe(200);
      expect([403, 404]).toContain(evil.statusCode);

      // The stored values are UNCHANGED (no unvalidated write landed).
      const rows = await db.execute(
        sql`select display_name, profile_photo_url from users where id = ${userId}`,
      );
      const row = (rows as unknown as Array<{ display_name: string; profile_photo_url: string }>)[0];
      expect(row).toBeDefined();
      expect(row!.display_name).toBe('Legit Name');
      expect(row!.profile_photo_url).toBe('https://cdn.example.com/ok.png');

      // GET /users/me still 200 (not bricked).
      const me = await app.inject({
        method: 'GET',
        url: '/users/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().displayName).toBe('Legit Name');
    });

    it('GET /users/me is robust to a pre-existing INVALID stored photo url', async () => {
      const email = mkEmail('me-robust');
      const { token, userId } = await signIn(email);

      // Simulate a bad value that a pre-hardening write could have stored.
      await db.execute(
        sql`update users set profile_photo_url = 'definitely not a url' where id = ${userId}`,
      );
      const me = await app.inject({
        method: 'GET',
        url: '/users/me',
        headers: { authorization: `Bearer ${token}` },
      });
      // Must NOT 422-brick; coerced to null instead.
      expect(me.statusCode).toBe(200);
      expect(me.json().profilePhotoUrl).toBeNull();
    });
  });

  // --- Finding 5: duplicate username race → 409 (not 500) ---------------------
  describe('duplicate username claim returns 409', () => {
    it('concurrent claims for the same username → 409 (catch path, not 500)', async () => {
      const a = mkEmail('dup-a');
      const b = mkEmail('dup-b');
      const ua = await signIn(a);
      const ub = await signIn(b);
      const wanted = `dupname_${RUN}`;

      // Fire both PATCHes concurrently so at least one races past the pre-check
      // and hits the unique-violation catch (the previously-dead detection path).
      const [r1, r2] = await Promise.all([
        app.inject({
          method: 'PATCH',
          url: '/users/me',
          headers: { authorization: `Bearer ${ua.token}` },
          payload: { username: wanted },
        }),
        app.inject({
          method: 'PATCH',
          url: '/users/me',
          headers: { authorization: `Bearer ${ub.token}` },
          payload: { username: wanted },
        }),
      ]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      // One wins (200), the other is a clean 409 — and NEITHER is a 500.
      expect(codes).toContain(200);
      expect(codes).toContain(409);
      expect(codes).not.toContain(500);
      const loser = r1.statusCode === 409 ? r1 : r2;
      expect(loser.json()).toMatchObject({ error: { code: 'conflict', status: 409 } });
    });

    it('sequential duplicate claim (pre-check path) also → 409', async () => {
      const a = mkEmail('dup2-a');
      const b = mkEmail('dup2-b');
      const ua = await signIn(a);
      const ub = await signIn(b);
      const wanted = `dupname2_${RUN}`;

      const first = await app.inject({
        method: 'PATCH',
        url: '/users/me',
        headers: { authorization: `Bearer ${ua.token}` },
        payload: { username: wanted },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'PATCH',
        url: '/users/me',
        headers: { authorization: `Bearer ${ub.token}` },
        payload: { username: wanted },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: { code: 'conflict', status: 409 } });
    });
  });

  // --- Finding 1: verify-attempt rate limiting + re-issue cannot reset budget --
  describe('OTP verify rate limiting (per-identifier, survives re-issue)', () => {
    it('rapid wrong /auth/verify for one identifier → 429 after the cap', async () => {
      const email = mkEmail('rl-verify');
      // Create the user first so verify reaches the budget check, not user-missing.
      await signIn(email);

      const { challengeId } = await freshChallenge(email);

      let saw429 = false;
      // 5 allowed attempts, the 6th+ must be 429 (cap is 5 / window).
      for (let i = 0; i < 8; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/verify',
          payload: { challengeId, code: '000000' }, // deliberately wrong
        });
        if (res.statusCode === 429) {
          saw429 = true;
          expect(res.json()).toMatchObject({ error: { code: 'rate_limited', status: 429 } });
          break;
        }
        // Before the cap, a wrong code is unauthorized (invalid/expired), never 200.
        expect(res.statusCode).not.toBe(200);
      }
      expect(saw429).toBe(true);
    });

    it('re-issuing /auth/start does NOT reset the verify-attempt budget', async () => {
      const email = mkEmail('rl-reissue');
      await signIn(email);

      // Burn the verify budget down with wrong codes until we hit 429.
      const { challengeId } = await freshChallenge(email);
      for (let i = 0; i < 8; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/verify',
          payload: { challengeId, code: '000000' },
        });
        if (res.statusCode === 429) break;
      }

      // Re-issue a FRESH OTP (new challenge + new code). Crucially DO NOT reset
      // the limit counters here — that's the attacker's move.
      await ensureRedis();
      // Only clear the SEND caps so /auth/start is allowed; leave verify budget.
      const id = normalizeIdentifier(email);
      await redis.del(`rl:${OTP_SEND_BUCKET_ID}:${id}`);
      await redis.del(`rl:${OTP_SEND_BUCKET_IP}:127.0.0.1`);

      const start = await app.inject({
        method: 'POST',
        url: '/auth/start',
        payload: { method: 'email', identifier: email },
      });
      expect(start.statusCode).toBe(200);
      const newChallenge = start.json().challengeId as string;
      const otpRes = await app.inject({
        method: 'GET',
        url: `/auth/dev/last-otp?identifier=${encodeURIComponent(email)}`,
      });
      const realCode = otpRes.json().code as string;

      // Even with the REAL fresh code, verify is still blocked: the per-identifier
      // budget was NOT reset by the re-issue.
      const res = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        payload: { challengeId: newChallenge, code: realCode },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: { code: 'rate_limited', status: 429 } });
      expect(res.json().accessToken).toBeUndefined();
    });
  });
});
