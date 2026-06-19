/**
 * Slice 3 auth integration test — REAL email-OTP flow against the LIVE stack
 * (Postgres + Redis). Exercises the actual HTTP routes via app.inject:
 *
 *   1. POST /auth/start (email)        → challengeId, OTP sent (dev transport)
 *   2. GET  /auth/dev/last-otp         → retrieve the real code (dev-only)
 *   3. POST /auth/verify               → session token (bearer)
 *   4. GET  /users/me  (bearer)        → 200, correct user
 *   5. PATCH /users/me (bearer)        → set username/display_name, persisted
 *   6. GET  /users/me  (no auth)       → 401
 *   7. requireSession rejects a SUSPENDED user → 403 suspended
 *
 * Each run uses a unique email so it is idempotent against the shared DB; created
 * rows are cleaned up in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { db, closeDb } from '../src/db/index.js';
import { closeRedis } from '../src/redis/index.js';
import { closeQueues } from '../src/queue/producers.js';

const unique = Date.now();
const EMAIL = `slice3-${unique}@twenty4.test`;
const USERNAME = `slice3_${unique}`;

describe('auth — full email-OTP flow (live DB + redis)', () => {
  let app: FastifyInstance;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    // Clean up rows this test created (cascades drop sessions/accounts).
    try {
      await db.execute(sql`delete from users where email = ${EMAIL}`);
    } catch {
      /* ignore */
    }
    await app.close();
    await Promise.allSettled([closeQueues(), closeRedis(), closeDb()]);
  });

  it('1) POST /auth/start sends an email OTP and returns a challengeId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/start',
      payload: { method: 'email', identifier: EMAIL },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.challengeId).toBe('string');
    expect(body.authenticated).toBe(false);
    // stash for verify
    (globalThis as Record<string, unknown>).__challengeId = body.challengeId;
  });

  it('2) GET /auth/dev/last-otp returns the real cached code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/dev/last-otp?identifier=${encodeURIComponent(EMAIL)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.identifier).toBe(EMAIL);
    expect(body.code).toMatch(/^\d{6}$/);
    (globalThis as Record<string, unknown>).__otp = body.code;
  });

  it('3) POST /auth/verify exchanges the OTP for a session token', async () => {
    const challengeId = (globalThis as Record<string, unknown>).__challengeId as string;
    const code = (globalThis as Record<string, unknown>).__otp as string;
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { challengeId, code },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken.length).toBeGreaterThan(10);
    // First-time sign-up has no username yet → needsProfile true.
    expect(body.needsProfile).toBe(true);
    expect(body.provider).toBe('email');
    token = body.accessToken;
  });

  it('4) GET /users/me with the bearer token returns the correct user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me.email).toBe(EMAIL.toLowerCase());
    expect(me.accountStatus).toBe('active');
    expect(typeof me.id).toBe('string');
    userId = me.id;
  });

  it('5) PATCH /users/me sets username + display_name and persists', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: USERNAME, displayName: 'Slice Three' },
    });
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me.username).toBe(USERNAME);
    expect(me.displayName).toBe('Slice Three');

    // Confirm persisted by re-reading from the DB directly.
    const rows = await db.execute(
      sql`select username, display_name from users where id = ${userId}`,
    );
    const row = (rows as unknown as Array<{ username: string; display_name: string }>)[0];
    expect(row?.username).toBe(USERNAME);
    expect(row?.display_name).toBe('Slice Three');
  });

  it('6) GET /users/me without a token is 401 unauthorized', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'unauthorized', status: 401 } });
  });

  it('7) requireSession rejects a SUSPENDED account with 403 suspended', async () => {
    // Suspend the user, then the same valid token must be rejected.
    await db.execute(sql`update users set account_status = 'suspended' where id = ${userId}`);
    const res = await app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'suspended', status: 403 } });

    // restore (afterAll deletes anyway)
    await db.execute(sql`update users set account_status = 'active' where id = ${userId}`);
  });
});
