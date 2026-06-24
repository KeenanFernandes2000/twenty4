// Group & invite routes (M3). All require a valid session (requireSession); every
// error uses the contracts envelope. Group-scoped reads/writes go through the
// shared authz gate (assertMemberOf / assertOwnerOf) — NO inline membership checks.
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AlreadyMemberError,
  CannotRemoveOwnerError,
  CannotRemoveSelfError,
  GroupNotFoundError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
  InviteUsedUpError,
  NotAMemberError,
  OwnerCannotLeaveError,
  ValidationError,
  createGroupReqSchema,
  patchGroupReqSchema,
  type GroupDTO,
  type InviteDTO,
  type InvitePreviewDTO,
  type JoinResultDTO,
  type MemberDTO,
} from "@twenty4/contracts";
import { group as groupTable, groupInvite, groupMember, user as userTable } from "@twenty4/contracts/db";
import { assertMemberOf, assertOwnerOf } from "./authz.ts";
import { generateInviteCode } from "./inviteCode.ts";
import type { InviteRateLimiter } from "./inviteRateLimit.ts";
import type { DbClient } from "../db.ts";
import type { makeRequireSession } from "../auth/guards.ts";

export interface GroupRoutesDeps {
  db: DbClient;
  requireSession: ReturnType<typeof makeRequireSession>;
  inviteRateLimiter: InviteRateLimiter;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const INVITE_MAX_USES = 25;

// Live count of active members for a group.
async function memberCount(db: DbClient, groupId: string): Promise<number> {
  const rows = await db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(groupMember)
    .where(and(eq(groupMember.groupId, groupId), eq(groupMember.status, "active")));
  return rows[0]?.n ?? 0;
}

function inviteToDto(row: typeof groupInvite.$inferSelect): InviteDTO {
  return {
    id: row.id,
    groupId: row.groupId,
    code: row.code,
    expiresAt: row.expiresAt.toISOString(),
    maxUses: row.maxUses,
    useCount: row.useCount,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function registerGroupRoutes(app: FastifyInstance, deps: GroupRoutesDeps): Promise<void> {
  const { db, requireSession, inviteRateLimiter } = deps;

  // ── POST /groups ──────────────────────────────────────────────────────────
  // Create group + insert creator as owner/active membership IN ONE TRANSACTION
  // (enforces "owner is a member" at the app layer — no PG CHECK; §10).
  app.post("/groups", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = createGroupReqSchema.parse(req.body);
    const u = req.user!;

    const created = await db.db.transaction(async (tx) => {
      const grows = await tx
        .insert(groupTable)
        .values({ name: body.name, photoUrl: body.photoUrl ?? null, ownerId: u.id })
        .returning();
      const g = grows[0]!;
      await tx.insert(groupMember).values({ groupId: g.id, userId: u.id, role: "owner", status: "active" });
      return g;
    });

    const dto: GroupDTO = {
      id: created.id,
      name: created.name,
      photoUrl: created.photoUrl,
      ownerId: created.ownerId,
      status: created.status,
      role: "owner",
      memberCount: 1,
      createdAt: created.createdAt.toISOString(),
    };
    reply.status(201).send(dto);
  });

  // ── GET /groups ───────────────────────────────────────────────────────────
  // Only groups where the caller has an ACTIVE membership (and the group is active).
  app.get("/groups", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const u = req.user!;
    const rows = await db.db
      .select({
        id: groupTable.id,
        name: groupTable.name,
        photoUrl: groupTable.photoUrl,
        ownerId: groupTable.ownerId,
        status: groupTable.status,
        createdAt: groupTable.createdAt,
        role: groupMember.role,
      })
      .from(groupMember)
      .innerJoin(groupTable, eq(groupTable.id, groupMember.groupId))
      .where(
        and(eq(groupMember.userId, u.id), eq(groupMember.status, "active"), eq(groupTable.status, "active")),
      );

    const out: GroupDTO[] = [];
    for (const r of rows) {
      out.push({
        id: r.id,
        name: r.name,
        photoUrl: r.photoUrl,
        ownerId: r.ownerId,
        status: r.status,
        role: r.role,
        memberCount: await memberCount(db, r.id),
        createdAt: r.createdAt.toISOString(),
      });
    }
    reply.status(200).send(out);
  });

  // ── GET /groups/{id} ──────────────────────────────────────────────────────
  // Member-only. Returns group + caller role + live member count.
  app.get("/groups/:id", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const u = req.user!;
    const role = await assertMemberOf(db, id, u.id);
    const rows = await db.db.select().from(groupTable).where(eq(groupTable.id, id)).limit(1);
    const g = rows[0];
    if (!g) throw new GroupNotFoundError();
    const dto: GroupDTO = {
      id: g.id,
      name: g.name,
      photoUrl: g.photoUrl,
      ownerId: g.ownerId,
      status: g.status,
      role,
      memberCount: await memberCount(db, id),
      createdAt: g.createdAt.toISOString(),
    };
    reply.status(200).send(dto);
  });

  // ── PATCH /groups/{id} ────────────────────────────────────────────────────
  // Owner-only. Rename and/or set/clear photo.
  app.patch("/groups/:id", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const u = req.user!;
    const body = patchGroupReqSchema.parse(req.body);
    await assertOwnerOf(db, id, u.id);

    const updates: Partial<typeof groupTable.$inferInsert> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.photoUrl !== undefined) updates.photoUrl = body.photoUrl; // null clears
    const urows = await db.db.update(groupTable).set(updates).where(eq(groupTable.id, id)).returning();
    const g = urows[0]!;
    const dto: GroupDTO = {
      id: g.id,
      name: g.name,
      photoUrl: g.photoUrl,
      ownerId: g.ownerId,
      status: g.status,
      role: "owner",
      memberCount: await memberCount(db, id),
      createdAt: g.createdAt.toISOString(),
    };
    reply.status(200).send(dto);
  });

  // ── DELETE /groups/{id} ───────────────────────────────────────────────────
  // Owner-only soft-archive (status=archived per §11 default).
  app.delete("/groups/:id", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const u = req.user!;
    await assertOwnerOf(db, id, u.id);
    await db.db.update(groupTable).set({ status: "archived" }).where(eq(groupTable.id, id));
    reply.status(200).send({ status: "archived" });
  });

  // ── POST /groups/{id}/invites ─────────────────────────────────────────────
  // Owner-only; rate-limited; collision-checked code; expires_at=now+7d; max_uses=25.
  app.post(
    "/groups/:id/invites",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      await assertOwnerOf(db, id, u.id);
      await inviteRateLimiter.checkCreate(u.id);

      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      // Collision-checked insert: retry on unique(code) violation.
      let inserted: typeof groupInvite.$inferSelect | undefined;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        const code = generateInviteCode();
        try {
          const rows = await db.db
            .insert(groupInvite)
            .values({ groupId: id, code, createdBy: u.id, expiresAt, maxUses: INVITE_MAX_USES, useCount: 0 })
            .returning();
          inserted = rows[0];
        } catch (err) {
          // 23505 = unique_violation → regenerate. Re-throw anything else.
          const code23505 = (err as { code?: string })?.code === "23505";
          if (!code23505) throw err;
        }
      }
      if (!inserted) throw new ValidationError("Could not mint a unique invite code; try again");
      reply.status(201).send(inviteToDto(inserted));
    },
  );

  // ── DELETE /groups/{id}/invites/{inviteId} ────────────────────────────────
  // Owner-only; idempotent revoke (sets revoked_at if not already set).
  app.delete(
    "/groups/:id/invites/:inviteId",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id, inviteId } = req.params as { id: string; inviteId: string };
      const u = req.user!;
      await assertOwnerOf(db, id, u.id);
      const rows = await db.db
        .select()
        .from(groupInvite)
        .where(and(eq(groupInvite.id, inviteId), eq(groupInvite.groupId, id)))
        .limit(1);
      const inv = rows[0];
      if (!inv) throw new InviteNotFoundError();
      // Idempotent: only set revoked_at the first time.
      if (!inv.revokedAt) {
        await db.db.update(groupInvite).set({ revokedAt: new Date() }).where(eq(groupInvite.id, inviteId));
      }
      reply.status(200).send({ status: "revoked" });
    },
  );

  // ── GET /invites/{code} ───────────────────────────────────────────────────
  // Auth-gated PREVIEW. Resolves validity (not-found/revoked/expired/used-up),
  // returns the group summary, and NEVER joins / consumes a use.
  app.get("/invites/:code", { preHandler: requireSession }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { code } = req.params as { code: string };
    const u = req.user!;
    const rows = await db.db.select().from(groupInvite).where(eq(groupInvite.code, code)).limit(1);
    const inv = rows[0];
    if (!inv) throw new InviteNotFoundError();
    if (inv.revokedAt) throw new InviteRevokedError();
    if (inv.expiresAt.getTime() <= Date.now()) throw new InviteExpiredError();
    if (inv.useCount >= inv.maxUses) throw new InviteUsedUpError();

    const grows = await db.db.select().from(groupTable).where(eq(groupTable.id, inv.groupId)).limit(1);
    const g = grows[0];
    if (!g || g.status !== "active") throw new GroupNotFoundError();

    // Is the previewing user already an active member?
    const mrows = await db.db
      .select({ status: groupMember.status })
      .from(groupMember)
      .where(and(eq(groupMember.groupId, g.id), eq(groupMember.userId, u.id), eq(groupMember.status, "active")))
      .limit(1);

    const dto: InvitePreviewDTO = {
      groupId: g.id,
      name: g.name,
      photoUrl: g.photoUrl,
      memberCount: await memberCount(db, g.id),
      alreadyMember: Boolean(mrows[0]),
    };
    reply.status(200).send(dto);
  });

  // ── POST /invites/{code}/join ─────────────────────────────────────────────
  // Atomic, race-safe join. The WHOLE operation runs in ONE transaction that
  // locks the invite row (SELECT ... FOR UPDATE) so concurrent joins — same OR
  // different users — serialize through the counter section. Each distinct user
  // who actually transitions into active membership consumes EXACTLY ONE use:
  //  1. Lock & classify the invite (DB clock) → not-found/revoked/expired/used-up.
  //  2. Group must be active (else GROUP_NOT_FOUND) — checked BEFORE any mutation,
  //     so there is no after-the-fact refund.
  //  3. If an ACTIVE membership already exists → ALREADY_MEMBER, consume NO use.
  //  4. Cap check: use_count >= max_uses → INVITE_USED_UP (no membership change).
  //  5. Increment use_count by 1 AND upsert the membership to active in the SAME
  //     txn. A same-user concurrent rejoin storm sees the active row at step 3 on
  //     all-but-one attempt → exactly one use consumed.
  app.post(
    "/invites/:code/join",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { code } = req.params as { code: string };
      const u = req.user!;
      await inviteRateLimiter.checkJoin(u.id);

      const groupId = await db.db.transaction(async (tx) => {
        // 1. Lock the invite row and read the DB clock + group status in one shot.
        //    FOR UPDATE serializes every concurrent join on this invite. The group
        //    join lets us reject archived groups without any counter mutation, and
        //    `isExpired` is evaluated by the DB clock (expires_at <= now()) — no JS
        //    clock skew can mislabel an expired invite as used-up.
        const irows = await tx
          .select({
            groupId: groupInvite.groupId,
            maxUses: groupInvite.maxUses,
            useCount: groupInvite.useCount,
            revokedAt: groupInvite.revokedAt,
            groupStatus: groupTable.status,
            isExpired: sql<boolean>`${groupInvite.expiresAt} <= now()`,
          })
          .from(groupInvite)
          .innerJoin(groupTable, eq(groupTable.id, groupInvite.groupId))
          .where(eq(groupInvite.code, code))
          .for("update", { of: groupInvite })
          .limit(1);
        const inv = irows[0];
        if (!inv) throw new InviteNotFoundError();

        // Classify invalidity with the DB clock, in spec order.
        if (inv.revokedAt) throw new InviteRevokedError();
        if (inv.isExpired) throw new InviteExpiredError();

        // 2. The invite's group must be active (else GROUP_NOT_FOUND) — checked
        //    before any counter mutation, so no refund is ever needed.
        if (inv.groupStatus !== "active") throw new GroupNotFoundError();

        // 3. Lock the caller's membership row (composite PK) and short-circuit an
        //    ACTIVE membership → ALREADY_MEMBER, consuming NO use. The lock keeps a
        //    same-user concurrent rejoin storm serialized on this row too.
        const mrows = await tx
          .select({ status: groupMember.status })
          .from(groupMember)
          .where(and(eq(groupMember.groupId, inv.groupId), eq(groupMember.userId, u.id)))
          .for("update")
          .limit(1);
        if (mrows[0]?.status === "active") throw new AlreadyMemberError();

        // 4. Enforce the cap (DB-read use_count under the lock — no overshoot).
        if (inv.useCount >= inv.maxUses) throw new InviteUsedUpError();

        // 5. Consume exactly one use AND upsert the membership to active, same txn.
        await tx
          .update(groupInvite)
          .set({ useCount: sql`${groupInvite.useCount} + 1` })
          .where(eq(groupInvite.code, code));

        await tx
          .insert(groupMember)
          .values({ groupId: inv.groupId, userId: u.id, role: "member", status: "active" })
          .onConflictDoUpdate({
            target: [groupMember.groupId, groupMember.userId],
            set: { status: "active", role: "member", joinedAt: new Date() },
          });

        return inv.groupId;
      });

      const dto: JoinResultDTO = { groupId, role: "member", status: "active" };
      reply.status(200).send(dto);
    },
  );

  // ── GET /groups/{id}/members ──────────────────────────────────────────────
  // Member-only; active members only.
  app.get(
    "/groups/:id/members",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      await assertMemberOf(db, id, u.id);
      const rows = await db.db
        .select({
          userId: groupMember.userId,
          role: groupMember.role,
          joinedAt: groupMember.joinedAt,
          displayName: userTable.displayName,
          username: userTable.username,
          profilePhotoUrl: userTable.profilePhotoUrl,
        })
        .from(groupMember)
        .innerJoin(userTable, eq(userTable.id, groupMember.userId))
        .where(and(eq(groupMember.groupId, id), eq(groupMember.status, "active")));
      const out: MemberDTO[] = rows.map((r) => ({
        userId: r.userId,
        role: r.role,
        displayName: r.displayName,
        username: r.username,
        profilePhotoUrl: r.profilePhotoUrl,
        joinedAt: r.joinedAt.toISOString(),
      }));
      reply.status(200).send(out);
    },
  );

  // ── DELETE /groups/{id}/members/{userId} ──────────────────────────────────
  // Owner-only. Reject self (CANNOT_REMOVE_SELF) and owner row (CANNOT_REMOVE_OWNER).
  app.delete(
    "/groups/:id/members/:userId",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const u = req.user!;
      const g = await assertOwnerOf(db, id, u.id);
      if (userId === u.id) throw new CannotRemoveSelfError();
      if (userId === g.ownerId) throw new CannotRemoveOwnerError();

      const mrows = await db.db
        .select({ status: groupMember.status })
        .from(groupMember)
        .where(and(eq(groupMember.groupId, id), eq(groupMember.userId, userId)))
        .limit(1);
      if (!mrows[0] || mrows[0].status !== "active") throw new NotAMemberError("That user is not a member");

      await db.db
        .update(groupMember)
        .set({ status: "removed" })
        .where(and(eq(groupMember.groupId, id), eq(groupMember.userId, userId)));
      reply.status(200).send({ status: "removed" });
    },
  );

  // ── POST /groups/{id}/leave ───────────────────────────────────────────────
  // Caller leaves (status=left). Owner cannot leave (OWNER_CANNOT_LEAVE; §11).
  app.post(
    "/groups/:id/leave",
    { preHandler: requireSession },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const u = req.user!;
      const role = await assertMemberOf(db, id, u.id);
      if (role === "owner") throw new OwnerCannotLeaveError();
      await db.db
        .update(groupMember)
        .set({ status: "left" })
        .where(and(eq(groupMember.groupId, id), eq(groupMember.userId, u.id)));
      reply.status(200).send({ status: "left" });
    },
  );
}
