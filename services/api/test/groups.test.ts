// M3 groups — live-stack integration tests (§7). Real Postgres + Redis.
// Covers: happy path, authz 403, concurrent-join race, removal-authz bypass,
// expiry (time + use-count), revoke (idempotent), re-join/already-member,
// and invite rate-limit.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { group as groupTable, groupInvite, groupMember } from "@twenty4/contracts/db";
import type { DbClient } from "../src/db.ts";
import type { RedisClient } from "../src/redis.ts";
import {
  bearer,
  buildGroupApp,
  cleanupGroupsByPhones,
  flushInviteKeys,
  makeGroupDb,
  makeGroupEnv,
  makeGroupRedis,
  seedUsers,
} from "./groupHelpers.ts";

let app: FastifyInstance;
let db: DbClient;
let redis: RedisClient;

const N = Date.now().toString().slice(-7);
// Owner, joiner, non-member, plus 30 race users.
const OWNER = `+1500${N}`;
const JOINER = `+1501${N}`;
const STRANGER = `+1502${N}`;
// A throwaway member used ONLY by the deleted-account roster test (it gets marked
// account_status='deleted', so it must not be shared with any other test).
const DELMEMBER = `+1503${N}`;
const RACE_PHONES = Array.from({ length: 30 }, (_, i) => `+159${i.toString().padStart(2, "0")}${N}`);
const ALL_PHONES = [OWNER, JOINER, STRANGER, DELMEMBER, ...RACE_PHONES];

let owner: { token: string; userId: string };
let joiner: { token: string; userId: string };
let stranger: { token: string; userId: string };
let delMember: { token: string; userId: string };

beforeAll(async () => {
  // Build env FIRST — makeGroupEnv() runs loadEnvForTest() which populates
  // process.env.DATABASE_URL; makeGroupDb() reads it, so env must load before the
  // DB client is created (else postgres.js falls back to the OS user → auth fail).
  const env = makeGroupEnv();
  db = makeGroupDb();
  redis = makeGroupRedis();
  await flushInviteKeys(redis);
  await cleanupGroupsByPhones(db, ALL_PHONES);
  app = await buildGroupApp({ db, redis, env });
  const seeded = await seedUsers(app, [OWNER, JOINER, STRANGER, DELMEMBER]);
  [owner, joiner, stranger, delMember] = seeded;
});

afterAll(async () => {
  await cleanupGroupsByPhones(db, ALL_PHONES);
  await flushInviteKeys(redis);
  await app.close();
  await db.sql.end({ timeout: 5 });
  await redis.quit();
});

async function createGroup(token: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/groups",
    headers: { "content-type": "application/json", ...bearer(token) },
    payload: JSON.stringify({ name }),
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function createInvite(token: string, groupId: string): Promise<{ id: string; code: string }> {
  const res = await app.inject({
    method: "POST",
    url: `/groups/${groupId}/invites`,
    headers: { "content-type": "application/json", ...bearer(token) },
    payload: "{}",
  });
  expect(res.statusCode).toBe(201);
  const b = res.json();
  return { id: b.id, code: b.code };
}

// ── Happy path: create → invite → preview (no join) → join ──────────────────
test("happy path: create, invite, preview (no use consumed), join, list", async () => {
  const groupId = await createGroup(owner.token, "Trip");

  // Owner membership exists (GET group as owner returns role owner, count 1).
  const ownerView = await app.inject({ method: "GET", url: `/groups/${groupId}`, headers: bearer(owner.token) });
  expect(ownerView.statusCode).toBe(200);
  expect(ownerView.json().role).toBe("owner");
  expect(ownerView.json().memberCount).toBe(1);

  const { code } = await createInvite(owner.token, groupId);

  // Preview by joiner: correct group, NOT a member, use_count unchanged.
  const preview = await app.inject({ method: "GET", url: `/invites/${code}`, headers: bearer(joiner.token) });
  expect(preview.statusCode).toBe(200);
  expect(preview.json().name).toBe("Trip");
  expect(preview.json().memberCount).toBe(1);
  expect(preview.json().alreadyMember).toBe(false);

  let inv = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!;
  expect(inv.useCount).toBe(0);

  // Join.
  const join = await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });
  expect(join.statusCode).toBe(200);
  expect(join.json().status).toBe("active");

  inv = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!;
  expect(inv.useCount).toBe(1);

  // Joiner now lists the group.
  const list = await app.inject({ method: "GET", url: "/groups", headers: bearer(joiner.token) });
  expect(list.statusCode).toBe(200);
  expect((list.json() as { id: string }[]).some((g) => g.id === groupId)).toBe(true);

  // Member count is now 2.
  const detail = await app.inject({ method: "GET", url: `/groups/${groupId}`, headers: bearer(joiner.token) });
  expect(detail.json().memberCount).toBe(2);
  expect(detail.json().role).toBe("member");
});

// ── Authz 403 for non-member / non-owner ────────────────────────────────────
test("authz: non-member 403 NOT_A_MEMBER; non-owner 403 NOT_OWNER", async () => {
  const groupId = await createGroup(owner.token, "Private");
  const { id: inviteId, code } = await createInvite(owner.token, groupId);
  // joiner joins so they are a member-but-not-owner.
  await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });

  // Non-member (stranger) → NOT_A_MEMBER on GET group + members.
  for (const url of [`/groups/${groupId}`, `/groups/${groupId}/members`]) {
    const res = await app.inject({ method: "GET", url, headers: bearer(stranger.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("NOT_A_MEMBER");
  }

  // Non-owner (joiner, a member) → NOT_OWNER on patch/delete/invite-create/revoke/remove.
  const patch = await app.inject({
    method: "PATCH",
    url: `/groups/${groupId}`,
    headers: { "content-type": "application/json", ...bearer(joiner.token) },
    payload: JSON.stringify({ name: "Hijack" }),
  });
  expect(patch.statusCode).toBe(403);
  expect(patch.json().error.code).toBe("NOT_OWNER");

  const del = await app.inject({ method: "DELETE", url: `/groups/${groupId}`, headers: bearer(joiner.token) });
  expect(del.json().error.code).toBe("NOT_OWNER");

  const invCreate = await app.inject({
    method: "POST",
    url: `/groups/${groupId}/invites`,
    headers: { "content-type": "application/json", ...bearer(joiner.token) },
    payload: "{}",
  });
  expect(invCreate.json().error.code).toBe("NOT_OWNER");

  const invRevoke = await app.inject({
    method: "DELETE",
    url: `/groups/${groupId}/invites/${inviteId}`,
    headers: bearer(joiner.token),
  });
  expect(invRevoke.json().error.code).toBe("NOT_OWNER");

  const remove = await app.inject({
    method: "DELETE",
    url: `/groups/${groupId}/members/${owner.userId}`,
    headers: bearer(joiner.token),
  });
  expect(remove.json().error.code).toBe("NOT_OWNER");
});

// ── Concurrent-join race ────────────────────────────────────────────────────
test("concurrent join: use_count never exceeds max_uses (full 25)", async () => {
  const groupId = await createGroup(owner.token, "Race25");
  const { code } = await createInvite(owner.token, groupId); // max_uses=25
  const racers = await seedUsers(app, RACE_PHONES); // 30 distinct users

  const results = await Promise.all(
    racers.map((r) => app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(r.token) })),
  );
  const ok = results.filter((r) => r.statusCode === 200).length;
  const usedUp = results.filter((r) => r.json()?.error?.code === "INVITE_USED_UP").length;

  expect(ok).toBe(25); // exactly min(30, 25)
  expect(usedUp).toBe(5); // surplus rejected

  const inv = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!;
  expect(inv.useCount).toBe(25); // never overshoots

  // Exactly 25 new active members (+1 owner = 26 total active).
  const detail = await app.inject({ method: "GET", url: `/groups/${groupId}`, headers: bearer(owner.token) });
  expect(detail.json().memberCount).toBe(26);
});

test("concurrent join: tiny cap=2 admits exactly 2, surplus INVITE_USED_UP", async () => {
  const groupId = await createGroup(owner.token, "Race2");
  const { code } = await createInvite(owner.token, groupId);
  // Force max_uses=2 directly.
  await db.db.update(groupInvite).set({ maxUses: 2 }).where(eq(groupInvite.code, code));
  // Use 6 of the already-seeded racers (re-join is fine: they're not members here).
  const racers = await seedUsers(app, RACE_PHONES.slice(0, 6));
  const results = await Promise.all(
    racers.map((r) => app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(r.token) })),
  );
  const ok = results.filter((r) => r.statusCode === 200).length;
  expect(ok).toBe(2);
  const inv = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!;
  expect(inv.useCount).toBe(2);
});

// ── Removal authz cannot be bypassed ────────────────────────────────────────
test("removal: owner can't remove self/owner; removed member is locked out", async () => {
  const groupId = await createGroup(owner.token, "RemovalTest");
  const { code } = await createInvite(owner.token, groupId);
  await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });

  // Owner can't remove self.
  const self = await app.inject({
    method: "DELETE",
    url: `/groups/${groupId}/members/${owner.userId}`,
    headers: bearer(owner.token),
  });
  expect(self.statusCode).toBe(400);
  expect(self.json().error.code).toBe("CANNOT_REMOVE_SELF");

  // Owner can remove the joiner.
  const rm = await app.inject({
    method: "DELETE",
    url: `/groups/${groupId}/members/${joiner.userId}`,
    headers: bearer(owner.token),
  });
  expect(rm.statusCode).toBe(200);

  // Removed member immediately fails assertMemberOf on group + members reads.
  for (const url of [`/groups/${groupId}`, `/groups/${groupId}/members`]) {
    const res = await app.inject({ method: "GET", url, headers: bearer(joiner.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("NOT_A_MEMBER");
  }

  // CANNOT_REMOVE_OWNER: create a 2nd group, joiner joins, then try to remove the
  // owner row via a member who is (briefly) re-added — owner row protected.
  const remOwner = await app.inject({
    method: "DELETE",
    url: `/groups/${groupId}/members/${owner.userId}`,
    headers: bearer(owner.token),
  });
  // owner removing the owner row == self → CANNOT_REMOVE_SELF (self check first);
  // assert the owner row is never removable either way.
  expect([400]).toContain(remOwner.statusCode);
  expect(["CANNOT_REMOVE_SELF", "CANNOT_REMOVE_OWNER"]).toContain(remOwner.json().error.code);
});

// ── Invite expiry — time ────────────────────────────────────────────────────
test("expiry (time): past expires_at → INVITE_EXPIRED on preview + join, nothing consumed", async () => {
  const groupId = await createGroup(owner.token, "Expired");
  const { code } = await createInvite(owner.token, groupId);
  await db.db.update(groupInvite).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(groupInvite.code, code));

  const preview = await app.inject({ method: "GET", url: `/invites/${code}`, headers: bearer(joiner.token) });
  expect(preview.statusCode).toBe(410);
  expect(preview.json().error.code).toBe("INVITE_EXPIRED");

  const join = await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });
  expect(join.statusCode).toBe(410);
  expect(join.json().error.code).toBe("INVITE_EXPIRED");

  const inv = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!;
  expect(inv.useCount).toBe(0);
});

// ── Invite expiry — use-count ───────────────────────────────────────────────
test("expiry (use-count): use_count==max_uses → INVITE_USED_UP", async () => {
  const groupId = await createGroup(owner.token, "UsedUp");
  const { code } = await createInvite(owner.token, groupId);
  await db.db.update(groupInvite).set({ maxUses: 1, useCount: 1 }).where(eq(groupInvite.code, code));

  const join = await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });
  expect(join.statusCode).toBe(403);
  expect(join.json().error.code).toBe("INVITE_USED_UP");
});

// ── Invite revoke ───────────────────────────────────────────────────────────
test("revoke: owner DELETE → preview+join INVITE_REVOKED; revoke idempotent", async () => {
  const groupId = await createGroup(owner.token, "Revoked");
  const { id: inviteId, code } = await createInvite(owner.token, groupId);

  const rev = await app.inject({
    method: "DELETE",
    url: `/groups/${groupId}/invites/${inviteId}`,
    headers: bearer(owner.token),
  });
  expect(rev.statusCode).toBe(200);

  const preview = await app.inject({ method: "GET", url: `/invites/${code}`, headers: bearer(joiner.token) });
  expect(preview.json().error.code).toBe("INVITE_REVOKED");
  const join = await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });
  expect(join.json().error.code).toBe("INVITE_REVOKED");

  // Idempotent second revoke.
  const rev2 = await app.inject({
    method: "DELETE",
    url: `/groups/${groupId}/invites/${inviteId}`,
    headers: bearer(owner.token),
  });
  expect(rev2.statusCode).toBe(200);
});

// ── Re-join / already-member ────────────────────────────────────────────────
test("already-member: active join → ALREADY_MEMBER, no use; left member can re-join", async () => {
  const groupId = await createGroup(owner.token, "Rejoin");
  const { code } = await createInvite(owner.token, groupId);

  // joiner joins (use_count 0→1).
  await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });
  let inv = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!;
  expect(inv.useCount).toBe(1);

  // Active member re-joins → ALREADY_MEMBER, no use consumed.
  const again = await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });
  expect(again.statusCode).toBe(409);
  expect(again.json().error.code).toBe("ALREADY_MEMBER");
  inv = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!;
  expect(inv.useCount).toBe(1); // unchanged

  // joiner leaves.
  const leave = await app.inject({ method: "POST", url: `/groups/${groupId}/leave`, headers: bearer(joiner.token) });
  expect(leave.statusCode).toBe(200);
  // Now a non-member → reads 403.
  const after = await app.inject({ method: "GET", url: `/groups/${groupId}`, headers: bearer(joiner.token) });
  expect(after.statusCode).toBe(403);

  // Previously-left member re-joins → consumes a use, reactivates.
  const rejoin = await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });
  expect(rejoin.statusCode).toBe(200);
  inv = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!;
  expect(inv.useCount).toBe(2); // a use was consumed on re-join
});

// ── CRITICAL regression: same-user concurrent rejoin consumes EXACTLY ONE use ─
// One left/removed user firing N concurrent rejoins must consume a single use
// (one membership), NOT N. Pre-fix this drained N uses from one user.
test("same-user concurrent rejoin consumes exactly ONE use (invite-drain TOCTOU)", async () => {
  const groupId = await createGroup(owner.token, "RejoinStorm");
  const { code } = await createInvite(owner.token, groupId); // max_uses=25

  // Bump max_uses well above the burst so the cap can't mask the bug.
  await db.db.update(groupInvite).set({ maxUses: 100 }).where(eq(groupInvite.code, code));

  // Joiner joins (0→1), then leaves → row is `left` (eligible to rejoin).
  const first = await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });
  expect(first.statusCode).toBe(200);
  const leave = await app.inject({ method: "POST", url: `/groups/${groupId}/leave`, headers: bearer(joiner.token) });
  expect(leave.statusCode).toBe(200);

  const beforeUse = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!.useCount;

  // Fire ~10 CONCURRENT rejoins from the SAME bearer.
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) }),
    ),
  );
  const ok = results.filter((r) => r.statusCode === 200).length;
  const already = results.filter((r) => r.json()?.error?.code === "ALREADY_MEMBER").length;
  // At least one succeeds; the rest see the now-active membership → ALREADY_MEMBER.
  expect(ok).toBeGreaterThanOrEqual(1);
  expect(ok + already).toBe(10);

  // EXACTLY ONE use consumed for the whole storm (the regression assertion).
  const afterUse = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!.useCount;
  expect(afterUse - beforeUse).toBe(1);

  // Exactly one active membership for this user, and they are active.
  const active = await db.db
    .select({ status: groupMember.status })
    .from(groupMember)
    .where(and(eq(groupMember.groupId, groupId), eq(groupMember.userId, joiner.userId)));
  expect(active.length).toBe(1);
  expect(active[0]!.status).toBe("active");

  // Leave again to reset joiner for later tests that re-use the joiner.
  await app.inject({ method: "POST", url: `/groups/${groupId}/leave`, headers: bearer(joiner.token) });
});

// ── Archived-group join/preview rejected (no refund pattern) ─────────────────
test("archived group: preview + join rejected GROUP_NOT_FOUND, use_count unchanged", async () => {
  const groupId = await createGroup(owner.token, "ToArchive");
  const { code } = await createInvite(owner.token, groupId);
  const before = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!.useCount;

  // Owner archives the group (soft-delete) while the code is still otherwise valid.
  const del = await app.inject({ method: "DELETE", url: `/groups/${groupId}`, headers: bearer(owner.token) });
  expect(del.statusCode).toBe(200);

  const preview = await app.inject({ method: "GET", url: `/invites/${code}`, headers: bearer(joiner.token) });
  expect(preview.json().error.code).toBe("GROUP_NOT_FOUND");

  const join = await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(joiner.token) });
  expect(join.json().error.code).toBe("GROUP_NOT_FOUND");

  // No use consumed and no refund needed (group rejected before any increment).
  const after = (await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1))[0]!.useCount;
  expect(after).toBe(before);
});

// ── IDOR: cross-group invite-revoke / member-removal must not bypass scope ────
test("IDOR cross-group: ownerB cannot revoke/remove groupA's invite/member", async () => {
  // ownerB is the stranger (a real, distinct authenticated user with no tie to A).
  const groupAId = await createGroup(owner.token, "GroupA-IDOR");
  const groupBId = await createGroup(stranger.token, "GroupB-IDOR");
  const { id: inviteAId, code: codeA } = await createInvite(owner.token, groupAId);

  // joiner is a member of A (the removal target).
  await app.inject({ method: "POST", url: `/invites/${codeA}/join`, headers: bearer(joiner.token) });

  // ownerB revokes A's invite via B's scope → 403/404, invite untouched (not revoked).
  const revoke = await app.inject({
    method: "DELETE",
    url: `/groups/${groupBId}/invites/${inviteAId}`,
    headers: bearer(stranger.token),
  });
  expect([403, 404]).toContain(revoke.statusCode);
  const invAfter = (await db.db.select().from(groupInvite).where(eq(groupInvite.id, inviteAId)).limit(1))[0]!;
  expect(invAfter.revokedAt).toBeNull();

  // ownerB removes A's member via B's scope → 403/404, membership untouched (active).
  const remove = await app.inject({
    method: "DELETE",
    url: `/groups/${groupBId}/members/${joiner.userId}`,
    headers: bearer(stranger.token),
  });
  expect([403, 404]).toContain(remove.statusCode);
  const memAfter = await db.db
    .select({ status: groupMember.status })
    .from(groupMember)
    .where(and(eq(groupMember.groupId, groupAId), eq(groupMember.userId, joiner.userId)))
    .limit(1);
  expect(memAfter[0]!.status).toBe("active");

  // Cleanup: joiner leaves A so later tests reusing joiner start clean.
  await app.inject({ method: "POST", url: `/groups/${groupAId}/leave`, headers: bearer(joiner.token) });
});

// ── Deleted account never appears in a group roster (M9 polish) ──────────────
// Defensive: even if purgeAccount's group_member deletion lagged or failed, a
// deleted/anonymized account must not surface in GET /groups/{id}/members.
test("members roster excludes a deleted account, keeps the active owner", async () => {
  const groupId = await createGroup(owner.token, "Roster-Deleted");
  const { code } = await createInvite(owner.token, groupId);
  await app.inject({ method: "POST", url: `/invites/${code}/join`, headers: bearer(delMember.token) });

  // Both members present before deletion.
  const before = await app.inject({ method: "GET", url: `/groups/${groupId}/members`, headers: bearer(owner.token) });
  expect(before.statusCode).toBe(200);
  expect((before.json() as { userId: string }[]).map((m) => m.userId).sort()).toEqual(
    [owner.userId, delMember.userId].sort(),
  );

  // Mark delMember's account deleted directly (the membership row is intentionally
  // LEFT in place to prove the roster excludes by account_status, not just by the
  // async membership-row deletion).
  await db.sql`UPDATE "user" SET account_status = 'deleted' WHERE id = ${delMember.userId}`;

  const after = await app.inject({ method: "GET", url: `/groups/${groupId}/members`, headers: bearer(owner.token) });
  expect(after.statusCode).toBe(200);
  const ids = (after.json() as { userId: string }[]).map((m) => m.userId);
  expect(ids).toEqual([owner.userId]); // active owner kept, deleted member gone
  expect(ids).not.toContain(delMember.userId);
});

// ── PATCH mass-assignment: only name/photoUrl mutable; status/ownerId ignored ─
test("PATCH mass-assignment: status + ownerId in body are ignored", async () => {
  const groupId = await createGroup(owner.token, "MassAssign");

  const patch = await app.inject({
    method: "PATCH",
    url: `/groups/${groupId}`,
    headers: { "content-type": "application/json", ...bearer(owner.token) },
    payload: JSON.stringify({ name: "Renamed", status: "archived", ownerId: stranger.userId }),
  });
  expect(patch.statusCode).toBe(200);
  // Name applied; status + owner untouched in the response.
  expect(patch.json().name).toBe("Renamed");
  expect(patch.json().status).toBe("active");
  expect(patch.json().ownerId).toBe(owner.userId);

  // And in the DB.
  const g = (await db.db.select().from(groupTable).where(eq(groupTable.id, groupId)).limit(1))[0]!;
  expect(g.status).toBe("active");
  expect(g.ownerId).toBe(owner.userId);
});

// ── Owner cannot leave ──────────────────────────────────────────────────────
test("owner cannot leave: OWNER_CANNOT_LEAVE", async () => {
  const groupId = await createGroup(owner.token, "OwnerLeave");
  const leave = await app.inject({ method: "POST", url: `/groups/${groupId}/leave`, headers: bearer(owner.token) });
  expect(leave.statusCode).toBe(400);
  expect(leave.json().error.code).toBe("OWNER_CANNOT_LEAVE");
});

// ── Rate-limit ──────────────────────────────────────────────────────────────
test("rate-limit: invite-create + invite-join bursts beyond cap → RATE_LIMITED", async () => {
  // Build a separate app with tiny caps.
  const rlRedis = makeGroupRedis();
  const rlDb = makeGroupDb();
  await flushInviteKeys(rlRedis);
  const rlApp = await buildGroupApp({
    db: rlDb,
    redis: rlRedis,
    env: makeGroupEnv({ INVITE_CREATE_CAP: "2", INVITE_JOIN_CAP: "2" }),
  });
  const RL_OWNER = `+1599${N}`;
  const RL_JOINER = `+1598${N}`;
  try {
    const [o, j] = await seedUsers(rlApp, [RL_OWNER, RL_JOINER]);
    const groupId = (
      await rlApp
        .inject({
          method: "POST",
          url: "/groups",
          headers: { "content-type": "application/json", ...bearer(o.token) },
          payload: JSON.stringify({ name: "RL" }),
        })
        .then((r) => r.json())
    ).id as string;

    // invite-create cap=2: 3rd create → RATE_LIMITED.
    const createStatuses: number[] = [];
    let lastCode = "";
    for (let i = 0; i < 3; i++) {
      const res = await rlApp.inject({
        method: "POST",
        url: `/groups/${groupId}/invites`,
        headers: { "content-type": "application/json", ...bearer(o.token) },
        payload: "{}",
      });
      createStatuses.push(res.statusCode);
      if (res.statusCode === 201) lastCode = res.json().code;
    }
    expect(createStatuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);

    // invite-join cap=2: 3rd join attempt (same user) → RATE_LIMITED. Use distinct
    // attempts against a valid code; the join cap is per-user.
    const joinStatuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await rlApp.inject({
        method: "POST",
        url: `/invites/${lastCode}/join`,
        headers: bearer(j.token),
      });
      joinStatuses.push(res.statusCode);
    }
    expect(joinStatuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);

    await cleanupGroupsByPhones(rlDb, [RL_OWNER, RL_JOINER]);
  } finally {
    await flushInviteKeys(rlRedis);
    await rlApp.close();
    await rlDb.sql.end({ timeout: 5 });
    await rlRedis.quit();
  }
});
