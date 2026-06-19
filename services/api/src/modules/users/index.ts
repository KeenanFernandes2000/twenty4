/**
 * users module (§8 users) — Slice 3 profile + account routes.
 *
 *   GET    /users/me   → the self profile (requireSession)
 *   PATCH  /users/me   → profile setup / edit: display_name, username (citext-
 *                        unique), profile_photo_url (1.4 / 5.2)
 *   DELETE /users/me   → account deletion: revoke ALL sessions, mark deleted,
 *                        enqueue purge-account (5.6 / §5). Worker job is a later
 *                        slice (enqueue + TODO here).
 */
import type { FastifyPluginAsync } from 'fastify';
import { and, eq, ne } from 'drizzle-orm';
import { users } from '@twenty4/contracts/db';
import { session as sessionTable } from '@twenty4/contracts/db';
import {
  updateUserRequestSchema,
  meResponseSchema,
  type MeResponse,
} from '@twenty4/contracts/dto';
import { errors } from '@twenty4/contracts/errors';

import { requireSession } from '../../auth/middleware.js';
import { db } from '../../db/index.js';
import { enqueuePurgeAccount } from '../../queue/producers.js';

/** Project a user row into the `me` response shape. */
function toMe(u: typeof users.$inferSelect): MeResponse {
  return meResponseSchema.parse({
    id: u.id,
    displayName: u.displayName ?? '',
    username: u.username ?? '',
    profilePhotoUrl: u.profilePhotoUrl ?? null,
    email: u.email ?? null,
    phone: u.phone ?? null,
    accountStatus: u.accountStatus,
    createdAt: u.createdAt.toISOString(),
  });
}

export const usersModule: FastifyPluginAsync = async (app) => {
  // ---- GET /users/me -------------------------------------------------------
  app.get('/me', { preHandler: requireSession }, async (req, reply) => {
    reply.code(200);
    return toMe(req.user!);
  });

  // ---- PATCH /users/me -----------------------------------------------------
  app.patch('/me', { preHandler: requireSession }, async (req, reply) => {
    const body = updateUserRequestSchema.parse(req.body);
    const me = req.user!;

    // Username conflict check (citext-unique). Only when changing it.
    if (body.username !== undefined && body.username !== me.username) {
      const [clash] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.username, body.username), ne(users.id, me.id)))
        .limit(1);
      if (clash) {
        throw errors.conflict('username already taken', { field: 'username' });
      }
    }

    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.username !== undefined) patch.username = body.username;
    if (body.profilePhotoUrl !== undefined) {
      patch.profilePhotoUrl = body.profilePhotoUrl;
    }

    if (Object.keys(patch).length === 0) {
      reply.code(200);
      return toMe(me);
    }

    try {
      const [updated] = await db
        .update(users)
        .set(patch)
        .where(eq(users.id, me.id))
        .returning();
      if (!updated) throw errors.internal('failed to update profile');
      reply.code(200);
      return toMe(updated);
    } catch (err) {
      // Unique-violation race (two requests claim the same username).
      if (isUniqueViolation(err)) {
        throw errors.conflict('username already taken', { field: 'username' });
      }
      throw err;
    }
  });

  // ---- DELETE /users/me ----------------------------------------------------
  app.delete('/me', { preHandler: requireSession }, async (req, reply) => {
    const me = req.user!;

    // 1) Revoke ALL sessions for the user (immediate, server-side).
    await db.delete(sessionTable).where(eq(sessionTable.userId, me.id));

    // 2) Mark the account deleted (requireSession rejects it from here on).
    await db
      .update(users)
      .set({ accountStatus: 'deleted' })
      .where(eq(users.id, me.id));

    // 3) Enqueue the purge job (worker hard-deletes content + row — later slice).
    await enqueuePurgeAccount({ userId: me.id, requestedAt: new Date().toISOString() });

    reply.code(204).send();
  });
};

/** True for a Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}
