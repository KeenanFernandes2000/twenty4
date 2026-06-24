// M2 auth — live-stack integration tests (§7). Real Postgres + Redis + Mailpit.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { errorEnvelopeSchema } from "@twenty4/contracts";
import { auditLog, session as sessionTable, user as userTable } from "@twenty4/contracts/db";
import type { DbClient } from "../src/db.ts";
import type { RedisClient } from "../src/redis.ts";
import {
  buildAuthApp,
  cleanupUser,
  flushOtpKeys,
  makeAuthDb,
  makeAuthEnv,
  makeAuthRedis,
  phoneLogin,
} from "./authHelpers.ts";

let app: FastifyInstance;
let db: DbClient;
let redis: RedisClient;

// Unique-ish identifiers so concurrent/rerun tests don't collide.
const N = Date.now().toString().slice(-7);
const PHONE = `+1555${N}`;
const EMAIL = `m2-${N}@example.com`;
const ADMIN_EMAIL = "admin@twenty4.app";
const SUSPENDED_PHONE = `+1666${N}`;
const BANNED_PHONE = `+1777${N}`;
const DELETED_PHONE = `+1888${N}`;

const MAILPIT = "http://localhost:8025";

beforeAll(async () => {
  db = makeAuthDb();
  redis = makeAuthRedis();
  await flushOtpKeys(redis);
  // Clean any leftovers from a prior run.
  for (const p of [PHONE, SUSPENDED_PHONE, BANNED_PHONE, DELETED_PHONE]) await cleanupUser(db, { phone: p });
  await cleanupUser(db, { email: EMAIL });
  await db.sql`DELETE FROM "user" WHERE email = ${ADMIN_EMAIL}`;
  app = await buildAuthApp({ db, redis, env: makeAuthEnv() });
});

afterAll(async () => {
  for (const p of [PHONE, SUSPENDED_PHONE, BANNED_PHONE, DELETED_PHONE]) await cleanupUser(db, { phone: p });
  await cleanupUser(db, { email: EMAIL });
  await db.sql`DELETE FROM "user" WHERE email = ${ADMIN_EMAIL}`;
  await flushOtpKeys(redis);
  await app.close();
  await db.sql.end({ timeout: 5 });
  await redis.quit();
});

// ── OTP happy path — phone ───────────────────────────────────────────────────
test("phone OTP: start → dev-last-otp → verify → PG session + bearer authenticates", async () => {
  const start = await app.inject({
    method: "POST",
    url: "/auth/start",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ identifier: PHONE, channel: "phone" }),
  });
  expect(start.statusCode).toBe(202);

  const dev = await app.inject({ method: "GET", url: `/auth/dev/last-otp?identifier=${encodeURIComponent(PHONE)}` });
  expect(dev.statusCode).toBe(200);
  const code = dev.json().code as string;
  expect(code).toMatch(/^\d{6}$/);

  const verify = await app.inject({
    method: "POST",
    url: "/auth/verify",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ identifier: PHONE, channel: "phone", code }),
  });
  expect(verify.statusCode).toBe(200);
  const { token, userId } = verify.json();
  expect(token).toBeTruthy();

  // PG session row exists for this token.
  const rows = await db.db.select().from(sessionTable).where(eq(sessionTable.token, token)).limit(1);
  expect(rows[0]?.userId).toBe(userId);

  // Bearer authenticates a guarded route.
  const me = await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token}` } });
  expect(me.statusCode).toBe(200);
  expect(me.json().id).toBe(userId);
});

// ── OTP happy path — email (read code from Mailpit REST) ─────────────────────
test("email OTP: start → read code from Mailpit → verify → session minted", async () => {
  // Clear Mailpit for determinism.
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });

  const start = await app.inject({
    method: "POST",
    url: "/auth/start",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ identifier: EMAIL, channel: "email" }),
  });
  expect(start.statusCode).toBe(202);

  // Poll Mailpit for the delivered email.
  let code: string | undefined;
  for (let i = 0; i < 20 && !code; i++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as {
      count: number;
      messages: { ID: string; Subject: string; To: { Address: string }[] }[];
    };
    const msg = list.messages?.find((m) => m.To?.some((t) => t.Address.toLowerCase() === EMAIL));
    if (msg) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json()) as {
        HTML: string;
        Text: string;
      };
      const m = `${full.HTML}\n${full.Text}`.match(/\b(\d{6})\b/);
      if (m) code = m[1];
    }
    if (!code) await new Promise((r) => setTimeout(r, 150));
  }
  expect(code).toMatch(/^\d{6}$/);

  const verify = await app.inject({
    method: "POST",
    url: "/auth/verify",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ identifier: EMAIL, channel: "email", code }),
  });
  expect(verify.statusCode).toBe(200);
  const { token, userId } = verify.json();
  const rows = await db.db.select().from(sessionTable).where(eq(sessionTable.token, token)).limit(1);
  expect(rows[0]?.userId).toBe(userId);
});

// ── Guarded route → 401 (missing / invalid) ──────────────────────────────────
test("guarded route returns 401 without a token", async () => {
  const res = await app.inject({ method: "GET", url: "/users/me" });
  expect(res.statusCode).toBe(401);
  expect(errorEnvelopeSchema.parse(res.json())).toBeDefined();
  expect(res.json().error.code).toBe("UNAUTHORIZED");
});

test("guarded route returns 401 with an invalid token", async () => {
  const res = await app.inject({ method: "GET", url: "/users/me", headers: { authorization: "Bearer not-a-real-token" } });
  expect(res.statusCode).toBe(401);
});

// ── Raw BA OTP route → 403 (no OTP sent) ─────────────────────────────────────
test("raw Better Auth OTP route is denied 403 and sends no OTP", async () => {
  const id = `+1999${N}`;
  await flushOtpKeys(redis);
  const res = await app.inject({
    method: "POST",
    url: "/phone-number/send-otp",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ phoneNumber: id }),
  });
  expect(res.statusCode).toBe(403);
  // No dev OTP was written for that identifier.
  const code = await redis.get(`otp:${id}`);
  expect(code).toBeNull();
});

// ── Throttle: per-identifier + per-IP caps → 429 (low caps via env) ──────────
test("OTP start trips 429 at the env-configured per-identifier cap", async () => {
  const id = `+1222${N}`;
  const throttledApp = await buildAuthApp({
    db,
    redis,
    env: makeAuthEnv({ OTP_MAX_PER_IDENTIFIER: "2", OTP_MAX_PER_IP: "1000" }),
  });
  await flushOtpKeys(redis);
  const send = () =>
    throttledApp.inject({
      method: "POST",
      url: "/auth/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ identifier: id, channel: "phone" }),
    });
  expect((await send()).statusCode).toBe(202);
  expect((await send()).statusCode).toBe(202);
  const third = await send();
  expect(third.statusCode).toBe(429);
  expect(third.json().error.code).toBe("RATE_LIMITED");
  await throttledApp.close();
  await cleanupUser(db, { phone: id });
});

test("OTP start trips 429 at the env-configured per-IP cap", async () => {
  const throttledApp = await buildAuthApp({
    db,
    redis,
    env: makeAuthEnv({ OTP_MAX_PER_IP: "2", OTP_MAX_PER_IDENTIFIER: "1000" }),
  });
  await flushOtpKeys(redis);
  const send = (id: string) =>
    throttledApp.inject({
      method: "POST",
      url: "/auth/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ identifier: id, channel: "phone" }),
    });
  expect((await send(`+1333${N}`)).statusCode).toBe(202);
  expect((await send(`+1334${N}`)).statusCode).toBe(202);
  expect((await send(`+1335${N}`)).statusCode).toBe(429);
  await throttledApp.close();
  for (const s of ["3", "4", "5"]) await cleanupUser(db, { phone: `+133${s}${N}` });
});

// ── Suspended / banned / deleted → verify denied 403, NO session row ─────────
for (const [label, phone, expectedCode, status] of [
  ["suspended", SUSPENDED_PHONE, "ACCOUNT_SUSPENDED", "suspended"],
  ["banned", BANNED_PHONE, "ACCOUNT_BANNED", "banned"],
  ["deleted", DELETED_PHONE, "ACCOUNT_DELETED", "deleted"],
] as const) {
  test(`${label} account cannot mint a session (403 ${expectedCode}, no session row)`, async () => {
    // First sign in normally to create the user, then flip status and re-verify.
    const { userId } = await phoneLogin(app, phone);
    // Wipe its session(s) and set the blocked status.
    await db.db.delete(sessionTable).where(eq(sessionTable.userId, userId));
    await db.db.update(userTable).set({ accountStatus: status }).where(eq(userTable.id, userId));

    // New OTP + verify must be denied.
    await app.inject({
      method: "POST",
      url: "/auth/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ identifier: phone, channel: "phone" }),
    });
    const dev = await app.inject({ method: "GET", url: `/auth/dev/last-otp?identifier=${encodeURIComponent(phone)}` });
    const code = dev.json().code as string;
    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ identifier: phone, channel: "phone", code }),
    });
    expect(verify.statusCode).toBe(403);
    expect(verify.json().error.code).toBe(expectedCode);

    // NO session row for this user.
    const rows = await db.db.select().from(sessionTable).where(eq(sessionTable.userId, userId));
    expect(rows.length).toBe(0);
  });
}

// ── requireAdmin: non-admin 403; admin allowed + audit_log row ───────────────
test("requireAdmin: non-admin gets 403", async () => {
  const { token } = await phoneLogin(app, `+1444${N}`);
  const res = await app.inject({ method: "GET", url: "/admin/ping", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(403);
  expect(res.json().error.code).toBe("FORBIDDEN");
  await cleanupUser(db, { phone: `+1444${N}` });
});

test("requireAdmin: admin (email in ADMIN_EMAILS) allowed + writes audit_log", async () => {
  // Email-OTP sign-in for the admin email so is_admin seeds.
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  await app.inject({
    method: "POST",
    url: "/auth/start",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ identifier: ADMIN_EMAIL, channel: "email" }),
  });
  let code: string | undefined;
  for (let i = 0; i < 20 && !code; i++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    const msg = list.messages?.find((m) => m.To?.some((t) => t.Address.toLowerCase() === ADMIN_EMAIL));
    if (msg) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json()) as { HTML: string; Text: string };
      const m = `${full.HTML}\n${full.Text}`.match(/\b(\d{6})\b/);
      if (m) code = m[1];
    }
    if (!code) await new Promise((r) => setTimeout(r, 150));
  }
  const verify = await app.inject({
    method: "POST",
    url: "/auth/verify",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ identifier: ADMIN_EMAIL, channel: "email", code }),
  });
  expect(verify.statusCode).toBe(200);
  const { token, userId } = verify.json();

  // is_admin seeded.
  const urows = await db.db.select().from(userTable).where(eq(userTable.id, userId)).limit(1);
  expect(urows[0]?.isAdmin).toBe(true);

  const before = await db.db.select().from(auditLog).where(eq(auditLog.actorId, userId));
  const res = await app.inject({ method: "GET", url: "/admin/ping", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  const after = await db.db.select().from(auditLog).where(eq(auditLog.actorId, userId));
  expect(after.length).toBe(before.length + 1);
  expect(after.at(-1)?.action).toBe("admin.ping");
});

// ── Logout revokes (previously-valid token now 401s) ─────────────────────────
test("logout revokes the session — the token then 401s", async () => {
  const phone = `+1555${N}9`;
  const { token } = await phoneLogin(app, phone);
  // Valid before.
  expect((await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  // Logout.
  const out = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
  expect(out.statusCode).toBe(200);
  // Now 401.
  expect((await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  await cleanupUser(db, { phone });
});

// ── DELETE /users/me marks deleted + revokes sessions ────────────────────────
test("DELETE /users/me marks the account deleted and revokes sessions", async () => {
  const phone = `+1556${N}`;
  const { token, userId } = await phoneLogin(app, phone);
  const res = await app.inject({ method: "DELETE", url: "/users/me", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  const urows = await db.db.select().from(userTable).where(eq(userTable.id, userId)).limit(1);
  expect(urows[0]?.accountStatus).toBe("deleted");
  const sessions = await db.db.select().from(sessionTable).where(eq(sessionTable.userId, userId));
  expect(sessions.length).toBe(0);
  await cleanupUser(db, { phone });
});

// ── CRITICAL-1: account_status enforced on EVERY guarded request ──────────────
// A previously-valid bearer is immediately locked out (403, NOT 401) once the
// account flips to suspended/banned/deleted — no re-login required to revoke.
for (const [digit, expectedCode, status] of [
  ["1", "ACCOUNT_SUSPENDED", "suspended"],
  ["2", "ACCOUNT_BANNED", "banned"],
  ["3", "ACCOUNT_DELETED", "deleted"],
] as const) {
  test(`valid bearer + status→${status}: guarded route 403 ${expectedCode}`, async () => {
    const phone = `+161${digit}${N}`;
    const { token, userId } = await phoneLogin(app, phone);
    // Valid while active.
    expect(
      (await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token}` } })).statusCode,
    ).toBe(200);
    // Flip the row directly (session row stays valid; only status changes).
    await db.db.update(userTable).set({ accountStatus: status }).where(eq(userTable.id, userId));
    const res = await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(expectedCode);
    await cleanupUser(db, { phone });
  });
}

// ── CRITICAL-2: /auth/refresh gated on account_status ─────────────────────────
test("suspended user gets 403 on /auth/refresh and NO token is returned", async () => {
  const phone = `+1622${N}`;
  const { token, userId } = await phoneLogin(app, phone);
  await db.db.update(userTable).set({ accountStatus: "suspended" }).where(eq(userTable.id, userId));
  const res = await app.inject({ method: "POST", url: "/auth/refresh", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(403);
  expect(res.json().error.code).toBe("ACCOUNT_SUSPENDED");
  expect(res.json().token).toBeUndefined();
  await cleanupUser(db, { phone });
});

// ── HIGH-1: X-Forwarded-For cannot bypass the per-IP OTP cap ──────────────────
// Same socket, rotating XFF values → still trips 429 because the per-IP key now
// derives from req.socket.remoteAddress, not the spoofable XFF-derived req.ip.
test("XFF spoofing does NOT bypass the per-IP OTP cap", async () => {
  const throttledApp = await buildAuthApp({
    db,
    redis,
    env: makeAuthEnv({ OTP_MAX_PER_IP: "2", OTP_MAX_PER_IDENTIFIER: "1000" }),
  });
  await flushOtpKeys(redis);
  const send = (id: string, xff: string) =>
    throttledApp.inject({
      method: "POST",
      url: "/auth/start",
      headers: { "content-type": "application/json", "x-forwarded-for": xff },
      payload: JSON.stringify({ identifier: id, channel: "phone" }),
    });
  // Distinct identifiers + distinct (spoofed) XFF each time → only the socket is shared.
  expect((await send(`+1671${N}`, "10.0.0.1")).statusCode).toBe(202);
  expect((await send(`+1672${N}`, "10.0.0.2")).statusCode).toBe(202);
  const third = await send(`+1673${N}`, "10.0.0.3");
  expect(third.statusCode).toBe(429);
  expect(third.json().error.code).toBe("RATE_LIMITED");
  await throttledApp.close();
  for (const s of ["1", "2", "3"]) await cleanupUser(db, { phone: `+167${s}${N}` });
});

// ── HIGH-2: identifier normalization → one shared counter ─────────────────────
// Case-variant emails key ONE per-identifier counter; with cap=1 the second
// case-variant is throttled (proves canonicalization before the Redis key).
test("identifier normalization: case-variant email shares one rate-limit counter", async () => {
  const throttledApp = await buildAuthApp({
    db,
    redis,
    env: makeAuthEnv({ OTP_MAX_PER_IDENTIFIER: "1", OTP_MAX_PER_IP: "1000" }),
  });
  await flushOtpKeys(redis);
  const email = `Norm-${N}@Example.COM`;
  const send = (id: string) =>
    throttledApp.inject({
      method: "POST",
      url: "/auth/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ identifier: id, channel: "email" }),
    });
  expect((await send(email)).statusCode).toBe(202);
  // Different casing → MUST hit the same counter → throttled.
  const second = await send(email.toLowerCase());
  expect(second.statusCode).toBe(429);
  expect(second.json().error.code).toBe("RATE_LIMITED");
  await throttledApp.close();
  await cleanupUser(db, { email: email.toLowerCase() });
});

// Phone normalization: surrounding whitespace canonicalizes to one key (the loose
// validator rejects in-string punctuation BEFORE the transform, so whitespace is
// the variation that survives validation yet must share a counter). Note: by spec
// "+1681…" vs "1681…" intentionally key DIFFERENT counters — we never guess a
// country code, so a bare-digits number is a distinct identifier from its +form.
test("identifier normalization: whitespace-variant phone shares one rate-limit counter", async () => {
  const throttledApp = await buildAuthApp({
    db,
    redis,
    env: makeAuthEnv({ OTP_MAX_PER_IDENTIFIER: "1", OTP_MAX_PER_IP: "1000" }),
  });
  await flushOtpKeys(redis);
  const phone = `+1681${N}`;
  const send = (id: string) =>
    throttledApp.inject({
      method: "POST",
      url: "/auth/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ identifier: id, channel: "phone" }),
    });
  expect((await send(phone)).statusCode).toBe(202);
  // Same number with surrounding whitespace → normalizes to "+<digits>" → same counter.
  const second = await send(`  ${phone}  `);
  expect(second.statusCode).toBe(429);
  expect(second.json().error.code).toBe("RATE_LIMITED");
  await throttledApp.close();
  await cleanupUser(db, { phone });
});

// ── #5: an EXPIRED session token → 401 ────────────────────────────────────────
test("an expired session token is rejected with 401", async () => {
  const phone = `+1633${N}`;
  const { token } = await phoneLogin(app, phone);
  // Valid before expiry.
  expect(
    (await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token}` } })).statusCode,
  ).toBe(200);
  // Force-expire the session row in PG.
  await db.db
    .update(sessionTable)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(sessionTable.token, token));
  const res = await app.inject({ method: "GET", url: "/users/me", headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(401);
  expect(res.json().error.code).toBe("UNAUTHORIZED");
  await cleanupUser(db, { phone });
});

// ── MEDIUM-1: case-insensitive deny-list match → 403 (not 404) ────────────────
test("a case-variant raw BA OTP path is denied 403 (not 404)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/PHONE-NUMBER/SEND-OTP",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ phoneNumber: `+1999${N}` }),
  });
  expect(res.statusCode).toBe(403);
  expect(res.json().error.code).toBe("FORBIDDEN");
});

test("a trailing-slash raw BA OTP path is denied 403 (not 404)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/phone-number/send-otp/",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ phoneNumber: `+1999${N}` }),
  });
  expect(res.statusCode).toBe(403);
  expect(res.json().error.code).toBe("FORBIDDEN");
});
