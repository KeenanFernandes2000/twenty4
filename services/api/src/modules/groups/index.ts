/**
 * groups module (§8 Groups) — Slice 4: group CRUD, members, invites, join/leave.
 *
 * Routes (all require a valid, active session via `requireSession`):
 *
 *   POST   /groups                       create (creator → owner member, txn)
 *   GET    /groups                       list caller's active groups (+count,role)
 *   GET    /groups/:id                   members-only group view
 *   PATCH  /groups/:id                   owner/admin: name/photo/status(archive)
 *   DELETE /groups/:id                   owner-only: archive (soft, §6 keeps no
 *                                         content tombstone for groups)
 *   GET    /groups/:id/members           members-only member list
 *   POST   /groups/:id/leave             caller leaves (sole-owner rule enforced)
 *   DELETE /groups/:id/members/:userId   owner/admin removes (role hierarchy)
 *   POST   /groups/:id/invites           owner/admin: mint code (expiry + use-cap)
 *   DELETE /groups/:id/invites/:inviteId owner/admin: revoke an invite
 *   GET    /invites/:code                public-ish preview (name/count/validity)
 *   POST   /invites/:code/join           redeem code → join (atomic, race-safe)
 *
 * The bare `/invites/:code` + `/invites/:code/join` paths from spec §8 are mounted
 * here too (this module is registered under BOTH /groups and at root for invites —
 * see app.ts). We additionally accept the prompt's `/groups/invites/:code` and
 * `/groups/join` aliases so either client wiring works.
 */
import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import {
  groups,
  groupMembers,
  groupInvites,
  users,
  type Group,
} from '@twenty4/contracts/db';
import {
  createGroupRequestSchema,
  updateGroupRequestSchema,
  createInviteRequestSchema,
  groupResponseSchema,
  groupListResponseSchema,
  groupMemberResponseSchema,
  inviteResponseSchema,
  invitePreviewResponseSchema,
  joinGroupResponseSchema,
  type GroupResponse,
  type GroupMemberResponse,
  type InviteResponse,
} from '@twenty4/contracts/dto';
import type { GroupMemberRole } from '@twenty4/contracts/enums';
import { errors } from '@twenty4/contracts/errors';

import { requireSession } from '../../auth/middleware.js';
import { db } from '../../db/index.js';
import {
  assertMemberOf,
  assertRole,
  getMembership,
  loadGroupOr404,
  outranks,
} from '../../authz/groupMembership.js';
import { throttleInviteJoin, throttleInvitePreview } from '../../lib/rateLimit.js';

/* --------------------------------- config ---------------------------------- */

/** Invite defaults (Q11): expire after 7 days OR 25 uses. */
const DEFAULT_INVITE_TTL_HOURS = 7 * 24;
const DEFAULT_INVITE_MAX_USES = 25;
/** Random invite code length (URL-safe base32-ish; 10 chars ≈ 50 bits). */
const INVITE_CODE_LEN = 10;
/** Deep-link scheme for invite share (PLAN §2). */
const inviteDeepLink = (code: string): string => `twenty4://invite/${code}`;

/* -------------------------------- helpers ---------------------------------- */

/** URL-safe code alphabet (no ambiguous 0/O/1/I/l). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Generate a random URL-safe invite code. */
function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LEN);
  let out = '';
  for (let i = 0; i < INVITE_CODE_LEN; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

/** Count ACTIVE members of a group. */
async function memberCount(
  groupId: string,
  conn: { execute: typeof db.execute } = db,
): Promise<number> {
  const rows = (await conn.execute(
    sql`select count(*)::int as n from group_members where group_id = ${groupId} and status = 'active'`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** Project a group row + caller's role + member count into the response DTO. */
function toGroupResponse(
  g: Group,
  myRole: GroupMemberRole,
  count: number,
): GroupResponse {
  return groupResponseSchema.parse({
    id: g.id,
    name: g.name,
    photoUrl: g.photoUrl ?? null,
    ownerId: g.ownerId,
    status: g.status,
    memberCount: count,
    myRole,
    createdAt: g.createdAt.toISOString(),
  });
}

/** An invite row is valid iff not revoked, not expired, and under its use-cap. */
function inviteIsValid(inv: {
  revokedAt: Date | null;
  expiresAt: Date;
  maxUses: number;
  useCount: number;
}): boolean {
  if (inv.revokedAt) return false;
  if (inv.expiresAt.getTime() <= Date.now()) return false;
  if (inv.useCount >= inv.maxUses) return false;
  return true;
}

/* --------------------------------- module ---------------------------------- */

export const groupsModule: FastifyPluginAsync = async (app) => {
  // Every route below is gated by a valid, active session.
  app.addHook('preHandler', requireSession);

  /* ---------------------------- POST /groups ------------------------------- */
  // Create a group; the creator is inserted as the `owner` member in ONE txn so
  // a group can never exist without its owner membership.
  app.post('/', async (req, reply) => {
    const body = createGroupRequestSchema.parse(req.body);
    const me = req.user!;

    const group = await db.transaction(async (tx) => {
      const [g] = await tx
        .insert(groups)
        .values({
          name: body.name,
          photoUrl: body.photoUrl ?? null,
          ownerId: me.id,
        })
        .returning();
      if (!g) throw errors.internal('failed to create group');
      await tx.insert(groupMembers).values({
        groupId: g.id,
        userId: me.id,
        role: 'owner',
        status: 'active',
      });
      return g;
    });

    reply.code(201);
    return toGroupResponse(group, 'owner', 1);
  });

  /* ----------------------------- GET /groups ------------------------------- */
  // List the caller's ACTIVE groups, each with member count + the caller's role.
  app.get('/', async (req, reply) => {
    const me = req.user!;
    const rows = (await db.execute(sql`
      select
        g.id, g.name, g.photo_url, g.owner_id, g.status, g.created_at,
        gm.role as my_role,
        (select count(*)::int from group_members m
           where m.group_id = g.id and m.status = 'active') as member_count
      from group_members gm
      join groups g on g.id = gm.group_id
      where gm.user_id = ${me.id} and gm.status = 'active'
      order by g.created_at desc
    `)) as unknown as Array<{
      id: string;
      name: string;
      photo_url: string | null;
      owner_id: string;
      status: Group['status'];
      created_at: Date;
      my_role: GroupMemberRole;
      member_count: number;
    }>;

    const items = rows.map((r) =>
      groupResponseSchema.parse({
        id: r.id,
        name: r.name,
        photoUrl: r.photo_url ?? null,
        ownerId: r.owner_id,
        status: r.status,
        memberCount: r.member_count,
        myRole: r.my_role,
        createdAt: new Date(r.created_at).toISOString(),
      }),
    );

    reply.code(200);
    return groupListResponseSchema.parse({ items });
  });

  /* --------------------------- GET /groups/:id ----------------------------- */
  // Members-only group view.
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const membership = await assertMemberOf(id, me.id);
    const group = await loadGroupOr404(id);
    const count = await memberCount(id);
    reply.code(200);
    return toGroupResponse(group, membership.role, count);
  });

  /* -------------------------- PATCH /groups/:id ---------------------------- */
  // Owner/admin: update name / photo / status (archive). Members can't.
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const body = updateGroupRequestSchema.parse(req.body);
    const membership = await assertRole(id, me.id, ['owner', 'admin']);

    const patch: Partial<typeof groups.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.photoUrl !== undefined) patch.photoUrl = body.photoUrl;
    if (body.status !== undefined) patch.status = body.status;

    if (Object.keys(patch).length === 0) {
      const group = await loadGroupOr404(id);
      const count = await memberCount(id);
      reply.code(200);
      return toGroupResponse(group, membership.role, count);
    }

    const [updated] = await db
      .update(groups)
      .set(patch)
      .where(eq(groups.id, id))
      .returning();
    if (!updated) throw errors.notFound('group not found');

    const count = await memberCount(id);
    reply.code(200);
    return toGroupResponse(updated, membership.role, count);
  });

  /* -------------------------- DELETE /groups/:id --------------------------- */
  // Owner-only: archive the group (status → 'archived'). We ARCHIVE rather than
  // hard-delete: §6's hard-deletion promise is about ephemeral *media*, not the
  // group container; archiving preserves member rows / audit and stops new feed
  // visibility. (A future admin hard-purge can cascade.)
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    await assertRole(id, me.id, ['owner']);
    const [updated] = await db
      .update(groups)
      .set({ status: 'archived' })
      .where(eq(groups.id, id))
      .returning();
    if (!updated) throw errors.notFound('group not found');
    reply.code(204).send();
  });

  /* ----------------------- GET /groups/:id/members ------------------------- */
  // Members-only: list ACTIVE members with their public summary + role.
  app.get('/:id/members', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    await assertMemberOf(id, me.id);

    const rows = await db
      .select({
        userId: groupMembers.userId,
        role: groupMembers.role,
        joinedAt: groupMembers.joinedAt,
        displayName: users.displayName,
        username: users.username,
        profilePhotoUrl: users.profilePhotoUrl,
      })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, id), eq(groupMembers.status, 'active')))
      .orderBy(groupMembers.joinedAt);

    const items: GroupMemberResponse[] = rows.map((r) =>
      groupMemberResponseSchema.parse({
        user: {
          id: r.userId,
          displayName: r.displayName ?? '',
          username: r.username ?? '',
          profilePhotoUrl: isHttpUrl(r.profilePhotoUrl) ? r.profilePhotoUrl : null,
        },
        role: r.role,
        joinedAt: new Date(r.joinedAt).toISOString(),
      }),
    );

    reply.code(200);
    return { items };
  });

  /* ------------------------ POST /groups/:id/leave ------------------------- */
  // Caller leaves. Owner-leave rule (spec): the SOLE owner cannot leave a group
  // that still has other members (they'd orphan it) — they must transfer
  // ownership (promote another member) or archive/delete it first. An owner who
  // is the LAST member may leave (group becomes empty; archived as a courtesy).
  app.post('/:id/leave', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;

    await db.transaction(async (tx) => {
      const membership = await getMembership(id, me.id, tx);
      if (!membership) throw errors.forbidden('not a member of this group');

      // Count active members + active owners (excluding state we're about to set).
      const counts = (await tx.execute(sql`
        select
          count(*) filter (where status = 'active')::int as active_members,
          count(*) filter (where status = 'active' and role = 'owner')::int as active_owners
        from group_members where group_id = ${id}
      `)) as unknown as Array<{ active_members: number; active_owners: number }>;
      const { active_members: activeMembers, active_owners: activeOwners } =
        counts[0] ?? { active_members: 0, active_owners: 0 };

      if (membership.role === 'owner' && activeOwners <= 1 && activeMembers > 1) {
        // Sole owner with other members still present → block (must transfer).
        throw errors.conflict(
          'sole owner cannot leave a non-empty group; transfer ownership or remove members first',
          { reason: 'sole_owner' },
        );
      }

      // Mark the membership 'left' (keep the row for audit; treated as non-member).
      await tx
        .update(groupMembers)
        .set({ status: 'left' })
        .where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, me.id)));

      // If that emptied the group, archive it.
      if (activeMembers <= 1) {
        await tx.update(groups).set({ status: 'archived' }).where(eq(groups.id, id));
      }
    });

    reply.code(204).send();
  });

  /* ----------------- DELETE /groups/:id/members/:userId -------------------- */
  // Owner/admin removes a member. Role hierarchy: actor must STRICTLY outrank the
  // target (admin cannot remove an owner or another admin; owner can remove
  // anyone but themselves). Self-removal must use POST /leave.
  app.delete('/:id/members/:userId', async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const me = req.user!;

    if (userId === me.id) {
      throw errors.conflict('use POST /groups/:id/leave to remove yourself', {
        reason: 'self_remove',
      });
    }

    const actor = await assertRole(id, me.id, ['owner', 'admin']);
    const target = await getMembership(id, userId, db);
    if (!target) throw errors.notFound('member not found');

    if (!outranks(actor.role, target.role)) {
      throw errors.forbidden('cannot remove a member of equal or higher role', {
        actorRole: actor.role,
        targetRole: target.role,
      });
    }

    await db
      .update(groupMembers)
      .set({ status: 'removed' })
      .where(and(eq(groupMembers.groupId, id), eq(groupMembers.userId, userId)));

    reply.code(204).send();
  });

  /* ---------------------- POST /groups/:id/invites ------------------------- */
  // Owner/admin mints a random invite code with expiry + use-cap (Q11).
  app.post('/:id/invites', async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.user!;
    const body = createInviteRequestSchema.parse(req.body ?? {});
    await assertRole(id, me.id, ['owner', 'admin']);
    // Group must still be active to invite into.
    const group = await loadGroupOr404(id);
    if (group.status !== 'active') {
      throw errors.conflict('cannot create invites for an archived group', {
        status: group.status,
      });
    }

    const maxUses = body.maxUses ?? DEFAULT_INVITE_MAX_USES;
    const ttlHours = body.expiresInHours ?? DEFAULT_INVITE_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    // Retry on the (astronomically unlikely) code collision against the unique idx.
    let invite: typeof groupInvites.$inferSelect | undefined;
    for (let attempt = 0; attempt < 5 && !invite; attempt++) {
      try {
        const [row] = await db
          .insert(groupInvites)
          .values({
            groupId: id,
            code: generateInviteCode(),
            createdBy: me.id,
            expiresAt,
            maxUses,
            useCount: 0,
          })
          .returning();
        invite = row;
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    if (!invite) throw errors.internal('failed to mint invite code');

    const res: InviteResponse = inviteResponseSchema.parse({
      code: invite.code,
      groupId: invite.groupId,
      expiresAt: invite.expiresAt.toISOString(),
      maxUses: invite.maxUses,
      useCount: invite.useCount,
      deepLink: inviteDeepLink(invite.code),
    });
    reply.code(201);
    return res;
  });

  /* ----------------- DELETE /groups/:id/invites/:inviteId ------------------ */
  // Owner/admin revokes an invite (sets revoked_at; subsequent joins fail 410).
  app.delete('/:id/invites/:inviteId', async (req, reply) => {
    const { id, inviteId } = req.params as { id: string; inviteId: string };
    const me = req.user!;
    await assertRole(id, me.id, ['owner', 'admin']);

    const [updated] = await db
      .update(groupInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(groupInvites.id, inviteId), eq(groupInvites.groupId, id)))
      .returning();
    if (!updated) throw errors.notFound('invite not found');
    reply.code(204).send();
  });
};

/**
 * Invite resolution + join routes mounted at the ROOT prefix (spec §8:
 * `GET /invites/{code}`, `POST /invites/{code}/join`). Registered separately in
 * app.ts so the paths are `/invites/...` not `/groups/invites/...`. We ALSO mount
 * `/groups/invites/:code` + `/groups/join` aliases inside groupsModule? No — kept
 * here so both live in one file. `requireSession` is applied per-route.
 */
export const invitesModule: FastifyPluginAsync = async (app) => {
  /* --------------------------- GET /invites/:code -------------------------- */
  // Preview: group name/photo + member count + validity. Requires a session
  // (no anonymous access in MVP) but does NOT require membership — that's the
  // point of a join preview. Leaks ONLY name/photo/count + a validity bool;
  // never the member list or whether the caller is blocked.
  app.get('/:code', { preHandler: requireSession }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const me = req.user!;
    // Rate-limit the preview: it exposes invite VALIDITY, so an unthrottled
    // endpoint is a code-validity oracle (enumerate codes → find live invites).
    await throttleInvitePreview({ userId: me.id, ip: req.ip });

    const [inv] = await db
      .select()
      .from(groupInvites)
      .where(eq(groupInvites.code, code))
      .limit(1);
    if (!inv) throw errors.notFound('invite not found');

    const [group] = await db
      .select()
      .from(groups)
      .where(eq(groups.id, inv.groupId))
      .limit(1);
    if (!group) throw errors.notFound('invite not found');

    const count = (await db.execute(
      sql`select count(*)::int as n from group_members where group_id = ${inv.groupId} and status = 'active'`,
    )) as unknown as Array<{ n: number }>;

    const valid = inviteIsValid(inv) && group.status === 'active';

    reply.code(200);
    return invitePreviewResponseSchema.parse({
      groupName: group.name,
      groupPhotoUrl: isHttpUrl(group.photoUrl) ? group.photoUrl : null,
      memberCount: count[0]?.n ?? 0,
      valid,
    });
  });

  /* ------------------------ POST /invites/:code/join ----------------------- */
  // Redeem a code → join the group. ATOMIC + RACE-SAFE:
  //   - rate-limit the attempt (abuse shaping; DB txn is the hard cap),
  //   - in ONE transaction: conditionally bump use_count ONLY while the invite is
  //     still valid (not revoked, not expired, use_count < max_uses) via a guarded
  //     UPDATE … RETURNING. The row lock that UPDATE takes serializes concurrent
  //     joiners, so on a max_uses=1 code exactly ONE racer's UPDATE returns a row;
  //     the rest see 0 rows updated → 410 invite_invalid. Then insert the member.
  app.post('/:code/join', { preHandler: requireSession }, async (req, reply) => {
    const { code } = req.params as { code: string };
    const me = req.user!;

    await throttleInviteJoin({ userId: me.id, ip: req.ip });

    const joined = await db.transaction(async (tx) => {
      // Lock + read the invite row.
      const [inv] = await tx
        .select()
        .from(groupInvites)
        .where(eq(groupInvites.code, code))
        .limit(1)
        .for('update');
      if (!inv) throw errors.notFound('invite not found');

      // Validity gates → precise contract codes.
      if (inv.revokedAt) throw errors.inviteInvalid('invite has been revoked');
      if (inv.expiresAt.getTime() <= Date.now())
        throw errors.inviteInvalid('invite has expired');
      if (inv.useCount >= inv.maxUses)
        throw errors.inviteInvalid('invite has reached its use limit');

      // Group must still be active.
      const [group] = await tx
        .select()
        .from(groups)
        .where(eq(groups.id, inv.groupId))
        .limit(1);
      if (!group) throw errors.notFound('invite not found');
      if (group.status !== 'active')
        throw errors.inviteInvalid('group is no longer active');

      // Inspect any prior membership row for this (group, user). We resolve its
      // status BEFORE consuming an invite use so a rejected attempt never burns
      // one. Three cases, by prior.status:
      //   - 'active'  → already a member; reject 409 (do NOT burn a use).
      //   - 'removed' → was kicked/removed by an owner/admin; MUST NOT self-rejoin
      //                 via an invite — reject 403 (do NOT burn a use). An owner
      //                 re-adding them is out of scope here.
      //   - 'left'    → they chose to leave; MAY rejoin (re-activate below).
      const existing = (await tx
        .select()
        .from(groupMembers)
        .where(
          and(eq(groupMembers.groupId, inv.groupId), eq(groupMembers.userId, me.id)),
        )
        .limit(1)) as Array<typeof groupMembers.$inferSelect>;
      const prior = existing[0];
      if (prior && prior.status === 'active') {
        throw errors.conflict('already a member of this group', {
          reason: 'already_member',
        });
      }
      if (prior && prior.status === 'removed') {
        // Removed members cannot self-rejoin via any invite. Reject WITHOUT
        // consuming a use so the code isn't griefed by a blocked user.
        throw errors.forbidden('you were removed from this group', {
          reason: 'removed_member',
        });
      }

      // Atomically consume one use, guarded so a racer that slipped past the read
      // (between SELECT … FOR UPDATE windows under READ COMMITTED is impossible
      // here since we hold the row lock, but the guard is belt-and-suspenders and
      // also covers expiry crossing mid-txn) can't over-cap.
      const bumped = await tx
        .update(groupInvites)
        .set({ useCount: sql`${groupInvites.useCount} + 1` })
        .where(
          and(
            eq(groupInvites.id, inv.id),
            sql`${groupInvites.useCount} < ${groupInvites.maxUses}`,
            sql`${groupInvites.revokedAt} is null`,
            sql`${groupInvites.expiresAt} > now()`,
          ),
        )
        .returning({ useCount: groupInvites.useCount });
      if (bumped.length === 0) {
        throw errors.inviteInvalid('invite is no longer valid');
      }

      // Insert OR re-activate the membership. `prior` here can only be a 'left'
      // row (active/removed already returned above), so re-activation is the
      // chosen-to-leave-then-rejoin path.
      if (prior) {
        await tx
          .update(groupMembers)
          .set({ status: 'active', role: 'member', joinedAt: new Date() })
          .where(
            and(
              eq(groupMembers.groupId, inv.groupId),
              eq(groupMembers.userId, me.id),
            ),
          );
      } else {
        await tx.insert(groupMembers).values({
          groupId: inv.groupId,
          userId: me.id,
          role: 'member',
          status: 'active',
        });
      }

      return group;
    });

    // Build the joined-group response (caller is now a 'member').
    const count = await memberCount(joined.id);
    reply.code(200);
    return joinGroupResponseSchema.parse(
      toGroupResponse(joined, 'member', count),
    );
  });
};

/* -------------------------------- shared utils ----------------------------- */

/** True if `v` is a parseable absolute URL (the strict-DTO photo contract). */
function isHttpUrl(v: string | null | undefined): v is string {
  if (!v) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505). Walks the
 * Drizzle → postgres.js cause chain (the SQLSTATE lives on `.cause`).
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 8; depth++) {
    if (typeof cur === 'object') {
      const e = cur as { code?: string };
      if (e.code === '23505') return true;
    }
    cur = (cur as { cause?: unknown })?.cause;
  }
  return false;
}
