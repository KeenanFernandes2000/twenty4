/**
 * Slice 4 groups integration test — REAL stack (Postgres + Redis), REAL sessions
 * minted through the Slice-3 email-OTP flow (POST /auth/start → dev OTP → verify).
 *
 * Proves (per Slice-4 acceptance):
 *   - create → creator is the `owner` member
 *   - non-member GET /groups/:id → 403 forbidden
 *   - member GET /groups/:id → 200
 *   - GET /groups lists caller's groups with role + member count
 *   - invite create requires owner/admin (member → 403)
 *   - join with a VALID code adds member + increments use_count
 *   - join with an EXPIRED code → rejected (410 invite_invalid)
 *   - join PAST max_uses → rejected (410)
 *   - CONCURRENCY: N parallel joins on a max_uses=1 code admit EXACTLY 1
 *   - already-member join → rejected (409 conflict)
 *   - leave works (membership → left)
 *   - admin CANNOT remove an owner (403); owner CAN remove a member
 *   - PATCH requires owner/admin (member → 403)
 *   - invite preview leaks only name/count/validity
 *
 * Created rows are cleaned up in afterAll (cascades drop memberships/invites).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { db, closeDb } from '../src/db/index.js';
import { closeRedis } from '../src/redis/index.js';
import { closeQueues } from '../src/queue/producers.js';

const unique = Date.now();
/** Short, handle-safe run id (base36) so usernames stay under the 24-char cap. */
const runId = unique.toString(36);

/** A signed-in test user: { token, userId, email }. */
interface TestUser {
  token: string;
  userId: string;
  email: string;
}

const emails: string[] = [];
/** Distinct fake client IP per signup so the per-IP OTP-send budget isn't shared. */
let ipCounter = 0;

describe('groups — CRUD + members + invites/join (live DB + redis)', () => {
  let app: FastifyInstance;

  /** Mint a fresh, profile-complete user via the real OTP flow. */
  async function signUp(tag: string): Promise<TestUser> {
    const email = `slice4-${tag}-${unique}@twenty4.test`;
    emails.push(email);

    // Each signup uses a DISTINCT client IP so the per-IP OTP-send budget
    // (≤5/10min/IP) is per-user, not shared across the suite — AND unique to this
    // run (derived from `unique`) so a re-run never collides with leftover Redis
    // counters from a prior run. trustProxy is on → x-forwarded-for sets req.ip.
    const n = ipCounter++;
    const ip = `10.${(unique >> 8) & 0xff}.${unique & 0xff}.${(n % 254) + 1}`;
    const xff = { 'x-forwarded-for': ip };

    const start = await app.inject({
      method: 'POST',
      url: '/auth/start',
      headers: xff,
      payload: { method: 'email', identifier: email },
    });
    expect(start.statusCode).toBe(200);
    const { challengeId } = start.json();

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

    // Complete the profile (username/displayName) so member summaries are valid.
    const patch = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: `s4${tag}${runId}`, displayName: `S4 ${tag}` },
    });
    expect(patch.statusCode).toBe(200);
    const userId = patch.json().id as string;

    return { token, userId, email };
  }

  function auth(u: TestUser) {
    return { authorization: `Bearer ${u.token}` };
  }

  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let outsider: TestUser;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // Sign users up SERIALLY. The shared lazy ioredis client throws if
    // `.connect()` is called concurrently while still connecting, which under
    // PARALLEL first-traffic would make the failClosed OTP-send limiter spuriously
    // 429 the burst. Serial signups connect it cleanly on the first call. The
    // concurrency we actually exercise is the parallel invite JOINS later, which
    // run once Redis is already connected.
    owner = await signUp('owner');
    admin = await signUp('admin');
    member = await signUp('member');
    outsider = await signUp('outsider');
  }, 60_000);

  afterAll(async () => {
    try {
      if (emails.length) {
        await db.execute(
          sql`delete from users where email in ${sql`(${sql.join(
            emails.map((e) => sql`${e}`),
            sql`, `,
          )})`}`,
        );
      }
    } catch {
      /* ignore */
    }
    await app.close();
    await Promise.allSettled([closeQueues(), closeRedis(), closeDb()]);
  });

  let groupId: string;

  it('create → creator is the owner member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/groups',
      headers: auth(owner),
      payload: { name: 'Slice4 Crew' },
    });
    expect(res.statusCode).toBe(201);
    const g = res.json();
    expect(g.name).toBe('Slice4 Crew');
    expect(g.ownerId).toBe(owner.userId);
    expect(g.myRole).toBe('owner');
    expect(g.memberCount).toBe(1);
    expect(g.status).toBe('active');
    groupId = g.id;

    // Confirm the owner membership row exists in the DB.
    const rows = (await db.execute(
      sql`select role, status from group_members where group_id = ${groupId} and user_id = ${owner.userId}`,
    )) as unknown as Array<{ role: string; status: string }>;
    expect(rows[0]?.role).toBe('owner');
    expect(rows[0]?.status).toBe('active');
  });

  it('non-member GET /groups/:id → 403 forbidden', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/groups/${groupId}`,
      headers: auth(outsider),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden', status: 403 } });
  });

  it('owner (member) GET /groups/:id → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/groups/${groupId}`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().myRole).toBe('owner');
  });

  it('GET /groups lists the caller groups with role + member count', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/groups',
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ id: string; myRole: string; memberCount: number }>;
    const mine = items.find((g) => g.id === groupId);
    expect(mine?.myRole).toBe('owner');
    expect(mine?.memberCount).toBe(1);
  });

  it('member CANNOT create an invite (needs owner/admin) → 403', async () => {
    // First, get `member` and `admin` into the group via a valid invite.
    const inv = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/invites`,
      headers: auth(owner),
      payload: {},
    });
    expect(inv.statusCode).toBe(201);
    const code = inv.json().code as string;
    expect(inv.json().deepLink).toBe(`twenty4://invite/${code}`);

    // join with a VALID code adds member + increments use_count -----------------
    const before = await inviteUseCount(code);
    const joinMember = await app.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      headers: auth(member),
    });
    expect(joinMember.statusCode).toBe(200);
    expect(joinMember.json().myRole).toBe('member');
    expect(await inviteUseCount(code)).toBe(before + 1);

    const joinAdmin = await app.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      headers: auth(admin),
    });
    expect(joinAdmin.statusCode).toBe(200);

    // Promote `admin` to admin role directly (no role-mgmt endpoint in MVP).
    await db.execute(
      sql`update group_members set role = 'admin' where group_id = ${groupId} and user_id = ${admin.userId}`,
    );

    // A plain MEMBER cannot mint an invite.
    const memberInvite = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/invites`,
      headers: auth(member),
      payload: {},
    });
    expect(memberInvite.statusCode).toBe(403);
    expect(memberInvite.json()).toMatchObject({ error: { code: 'forbidden' } });

    // An ADMIN can mint an invite.
    const adminInvite = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/invites`,
      headers: auth(admin),
      payload: {},
    });
    expect(adminInvite.statusCode).toBe(201);
  });

  it('already-member join → rejected (409 conflict)', async () => {
    const inv = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/invites`,
      headers: auth(owner),
      payload: {},
    });
    const code = inv.json().code as string;
    const res = await app.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      headers: auth(member),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  it('join with an EXPIRED code → rejected (410)', async () => {
    const inv = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/invites`,
      headers: auth(owner),
      payload: {},
    });
    const code = inv.json().code as string;
    // Force expiry in the past.
    await db.execute(
      sql`update group_invites set expires_at = now() - interval '1 hour' where code = ${code}`,
    );
    const res = await app.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      headers: auth(outsider),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: { code: 'invite_invalid', status: 410 } });
  });

  it('join PAST max_uses → rejected (410)', async () => {
    const inv = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/invites`,
      headers: auth(owner),
      payload: { maxUses: 1 },
    });
    const code = inv.json().code as string;
    // Saturate the cap directly.
    await db.execute(
      sql`update group_invites set use_count = max_uses where code = ${code}`,
    );
    const res = await app.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      headers: auth(outsider),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: { code: 'invite_invalid' } });
  });

  it('CONCURRENCY: N parallel joins on a max_uses=1 code admit exactly 1', async () => {
    // Fresh group owned by `owner`, fresh single-use invite, racers join in parallel.
    const create = await app.inject({
      method: 'POST',
      url: '/groups',
      headers: auth(owner),
      payload: { name: 'Race Group' },
    });
    const raceGroupId = create.json().id as string;

    const inv = await app.inject({
      method: 'POST',
      url: `/groups/${raceGroupId}/invites`,
      headers: auth(owner),
      payload: { maxUses: 1 },
    });
    const code = inv.json().code as string;

    // Spin up several fresh users SERIALLY (signup OTP flow is sequential to keep
    // rate-limit budgets clean); the JOINS below are what run in PARALLEL.
    const racers: TestUser[] = [];
    for (const tag of ['race1', 'race2', 'race3', 'race4', 'race5']) {
      racers.push(await signUp(tag));
    }

    const results = await Promise.all(
      racers.map((r) =>
        app.inject({
          method: 'POST',
          url: `/invites/${code}/join`,
          headers: auth(r),
        }),
      ),
    );

    const ok = results.filter((r) => r.statusCode === 200);
    const rejected = results.filter((r) => r.statusCode === 410);
    expect(ok.length).toBe(1);
    expect(rejected.length).toBe(racers.length - 1);

    // use_count must be exactly 1 (never over-cap).
    const finalCount = await inviteUseCount(code);
    expect(finalCount).toBe(1);

    // Exactly ONE extra active member beyond the owner.
    const memberRows = (await db.execute(
      sql`select count(*)::int as n from group_members where group_id = ${raceGroupId} and status = 'active'`,
    )) as unknown as Array<{ n: number }>;
    expect(memberRows[0]?.n).toBe(2);
  }, 60_000);

  it('PATCH requires owner/admin (member → 403; owner → 200)', async () => {
    const memberPatch = await app.inject({
      method: 'PATCH',
      url: `/groups/${groupId}`,
      headers: auth(member),
      payload: { name: 'Hijacked' },
    });
    expect(memberPatch.statusCode).toBe(403);

    const ownerPatch = await app.inject({
      method: 'PATCH',
      url: `/groups/${groupId}`,
      headers: auth(owner),
      payload: { name: 'Renamed Crew' },
    });
    expect(ownerPatch.statusCode).toBe(200);
    expect(ownerPatch.json().name).toBe('Renamed Crew');
  });

  it('GET /groups/:id/members is members-only and lists active members', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: `/groups/${groupId}/members`,
      headers: auth(outsider),
    });
    expect(forbidden.statusCode).toBe(403);

    const res = await app.inject({
      method: 'GET',
      url: `/groups/${groupId}/members`,
      headers: auth(owner),
    });
    expect(res.statusCode).toBe(200);
    const members = res.json().items as Array<{ user: { id: string }; role: string }>;
    const ids = members.map((m) => m.user.id);
    expect(ids).toContain(owner.userId);
    expect(ids).toContain(member.userId);
    expect(members.find((m) => m.user.id === owner.userId)?.role).toBe('owner');
  });

  it('admin CANNOT remove the owner; owner CAN remove a member', async () => {
    // admin (role=admin) tries to remove the owner → 403 (cannot remove higher).
    const adminRemovesOwner = await app.inject({
      method: 'DELETE',
      url: `/groups/${groupId}/members/${owner.userId}`,
      headers: auth(admin),
    });
    expect(adminRemovesOwner.statusCode).toBe(403);
    expect(adminRemovesOwner.json()).toMatchObject({ error: { code: 'forbidden' } });

    // Owner removes `member` → 204, membership becomes 'removed'.
    const ownerRemovesMember = await app.inject({
      method: 'DELETE',
      url: `/groups/${groupId}/members/${member.userId}`,
      headers: auth(owner),
    });
    expect(ownerRemovesMember.statusCode).toBe(204);

    const rows = (await db.execute(
      sql`select status from group_members where group_id = ${groupId} and user_id = ${member.userId}`,
    )) as unknown as Array<{ status: string }>;
    expect(rows[0]?.status).toBe('removed');

    // The removed member is now treated as a non-member (403 on the group).
    const removedView = await app.inject({
      method: 'GET',
      url: `/groups/${groupId}`,
      headers: auth(member),
    });
    expect(removedView.statusCode).toBe(403);
  });

  it('leave works (membership → left); sole owner of non-empty group cannot leave', async () => {
    // `admin` is still an active member → can leave cleanly.
    const adminLeaves = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/leave`,
      headers: auth(admin),
    });
    expect(adminLeaves.statusCode).toBe(204);
    const rows = (await db.execute(
      sql`select status from group_members where group_id = ${groupId} and user_id = ${admin.userId}`,
    )) as unknown as Array<{ status: string }>;
    expect(rows[0]?.status).toBe('left');

    // Now owner is the only active member → owner CAN leave (group archives).
    const ownerLeaves = await app.inject({
      method: 'POST',
      url: `/groups/${groupId}/leave`,
      headers: auth(owner),
    });
    expect(ownerLeaves.statusCode).toBe(204);
    const g = (await db.execute(
      sql`select status from groups where id = ${groupId}`,
    )) as unknown as Array<{ status: string }>;
    expect(g[0]?.status).toBe('archived');
  });

  it('sole owner with other members CANNOT leave (409)', async () => {
    // New group, add a second member, then owner tries to leave → blocked.
    const create = await app.inject({
      method: 'POST',
      url: '/groups',
      headers: auth(owner),
      payload: { name: 'Cant Leave' },
    });
    const gid = create.json().id as string;

    const inv = await app.inject({
      method: 'POST',
      url: `/groups/${gid}/invites`,
      headers: auth(owner),
      payload: {},
    });
    const code = inv.json().code as string;
    const join = await app.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      headers: auth(outsider),
    });
    expect(join.statusCode).toBe(200);

    const leave = await app.inject({
      method: 'POST',
      url: `/groups/${gid}/leave`,
      headers: auth(owner),
    });
    expect(leave.statusCode).toBe(409);
    expect(leave.json()).toMatchObject({ error: { code: 'conflict' } });
  });

  it('invite preview returns only name/count/validity (no member leak)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/groups',
      headers: auth(owner),
      payload: { name: 'Preview Group' },
    });
    const gid = create.json().id as string;
    const inv = await app.inject({
      method: 'POST',
      url: `/groups/${gid}/invites`,
      headers: auth(owner),
      payload: {},
    });
    const code = inv.json().code as string;

    const preview = await app.inject({
      method: 'GET',
      url: `/invites/${code}`,
      headers: auth(outsider),
    });
    expect(preview.statusCode).toBe(200);
    const body = preview.json();
    expect(body.groupName).toBe('Preview Group');
    expect(body.memberCount).toBe(1);
    expect(body.valid).toBe(true);
    // No member list / no caller-membership leak.
    expect(body).not.toHaveProperty('members');
    expect(Object.keys(body).sort()).toEqual(
      ['groupName', 'groupPhotoUrl', 'memberCount', 'valid'].sort(),
    );
  });

  it('removed member CANNOT self-rejoin via a valid invite; a member who LEFT can', async () => {
    // Fresh group + two fresh users: one we'll REMOVE, one we'll have LEAVE.
    const create = await app.inject({
      method: 'POST',
      url: '/groups',
      headers: auth(owner),
      payload: { name: 'Rejoin Rules' },
    });
    const gid = create.json().id as string;

    const removedUser = await signUp('removed');
    const leftUser = await signUp('left');

    // Both join via a multi-use invite.
    const inv1 = await app.inject({
      method: 'POST',
      url: `/groups/${gid}/invites`,
      headers: auth(owner),
      payload: { maxUses: 25 },
    });
    const joinCode = inv1.json().code as string;
    for (const u of [removedUser, leftUser]) {
      const j = await app.inject({
        method: 'POST',
        url: `/invites/${joinCode}/join`,
        headers: auth(u),
      });
      expect(j.statusCode).toBe(200);
    }

    // Owner REMOVES removedUser; leftUser voluntarily LEAVES.
    const remove = await app.inject({
      method: 'DELETE',
      url: `/groups/${gid}/members/${removedUser.userId}`,
      headers: auth(owner),
    });
    expect(remove.statusCode).toBe(204);
    const leave = await app.inject({
      method: 'POST',
      url: `/groups/${gid}/leave`,
      headers: auth(leftUser),
    });
    expect(leave.statusCode).toBe(204);

    // A fresh, VALID invite to attempt rejoin with.
    const inv2 = await app.inject({
      method: 'POST',
      url: `/groups/${gid}/invites`,
      headers: auth(owner),
      payload: { maxUses: 25 },
    });
    const rejoinCode = inv2.json().code as string;
    const useBefore = await inviteUseCount(rejoinCode);

    // REMOVED user attempts rejoin → 403 forbidden (NOT re-activated).
    const removedRejoin = await app.inject({
      method: 'POST',
      url: `/invites/${rejoinCode}/join`,
      headers: auth(removedUser),
    });
    expect(removedRejoin.statusCode).toBe(403);
    expect(removedRejoin.json()).toMatchObject({
      error: { code: 'forbidden', status: 403 },
    });
    // The membership row stays 'removed' (no silent auto-rejoin).
    const removedRows = (await db.execute(
      sql`select status from group_members where group_id = ${gid} and user_id = ${removedUser.userId}`,
    )) as unknown as Array<{ status: string }>;
    expect(removedRows[0]?.status).toBe('removed');
    // Crucially: the rejected attempt did NOT burn a use.
    expect(await inviteUseCount(rejoinCode)).toBe(useBefore);

    // LEFT user CAN rejoin with the same valid code → 200, membership active.
    const leftRejoin = await app.inject({
      method: 'POST',
      url: `/invites/${rejoinCode}/join`,
      headers: auth(leftUser),
    });
    expect(leftRejoin.statusCode).toBe(200);
    expect(leftRejoin.json().myRole).toBe('member');
    const leftRows = (await db.execute(
      sql`select status from group_members where group_id = ${gid} and user_id = ${leftUser.userId}`,
    )) as unknown as Array<{ status: string }>;
    expect(leftRows[0]?.status).toBe('active');
    // The successful rejoin DID consume one use.
    expect(await inviteUseCount(rejoinCode)).toBe(useBefore + 1);
  }, 60_000);

  it('GET /invites/:code is rate-limited (per-user/per-IP) → 429 after the cap', async () => {
    // Dedicated user + dedicated client IP so the preview counters are isolated
    // from the rest of the suite (which shares the inject default IP).
    const previewer = await signUp('previewer');
    const previewIp = `10.99.${(unique >> 8) & 0xff}.${(unique & 0xff) || 1}`;

    const create = await app.inject({
      method: 'POST',
      url: '/groups',
      headers: auth(owner),
      payload: { name: 'Oracle Group' },
    });
    const gid = create.json().id as string;
    const inv = await app.inject({
      method: 'POST',
      url: `/groups/${gid}/invites`,
      headers: auth(owner),
      payload: {},
    });
    const code = inv.json().code as string;

    // INVITE_PREVIEW_MAX = 30 / 10min. Hammer past the cap; expect a 429 to appear.
    let saw429 = false;
    let okCount = 0;
    for (let i = 0; i < 35; i++) {
      const res = await app.inject({
        method: 'GET',
        url: `/invites/${code}`,
        headers: { ...auth(previewer), 'x-forwarded-for': previewIp },
      });
      if (res.statusCode === 429) {
        saw429 = true;
        expect(res.json()).toMatchObject({
          error: { code: 'rate_limited', status: 429 },
        });
        break;
      }
      expect(res.statusCode).toBe(200);
      okCount++;
    }
    expect(saw429).toBe(true);
    // The cap let through at most the configured allowance before tripping.
    expect(okCount).toBeLessThanOrEqual(30);
    expect(okCount).toBeGreaterThan(0);
  }, 60_000);

  /** Read an invite's current use_count from the DB. */
  async function inviteUseCount(code: string): Promise<number> {
    const rows = (await db.execute(
      sql`select use_count from group_invites where code = ${code}`,
    )) as unknown as Array<{ use_count: number }>;
    return rows[0]?.use_count ?? -1;
  }
});
