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
import { emitAccountDeletionRequested } from '../../analytics/emit.js';

/**
 * Project a user row into the `me` response shape.
 *
 * DEFENSIVE: `meResponseSchema` is strict and requires `profilePhotoUrl` to be a
 * valid URL. A bad value could have been stored before this hardening (e.g. via
 * the now-blocked Better Auth /auth/update-user writing an unvalidated `image`).
 * Rather than 422-bricking GET /users/me, we coerce an invalid stored URL to null
 * so the self profile always renders. The validated PATCH /users/me remains the
 * only path that can store a (valid) value.
 */
function toMe(u: typeof users.$inferSelect): MeResponse {
  const photo = u.profilePhotoUrl ?? null;
  const safePhoto =
    photo !== null && !isHttpUrl(photo) ? null : photo;
  return meResponseSchema.parse({
    id: u.id,
    displayName: u.displayName ?? '',
    username: u.username ?? '',
    profilePhotoUrl: safePhoto,
    email: u.email ?? null,
    phone: u.phone ?? null,
    accountStatus: u.accountStatus,
    createdAt: u.createdAt.toISOString(),
  });
}

/** True if `v` parses as an absolute URL (the meResponse photo contract). */
function isHttpUrl(v: string): boolean {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
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

    // Atomic: revoke ALL sessions + mark the account deleted in ONE transaction
    // so we can't end up half-revoked (sessions gone but status still active, or
    // vice-versa). The purge job is enqueued ONLY after the commit succeeds, so a
    // rolled-back delete never schedules a destructive worker run.
    await db.transaction(async (tx) => {
      // 1) Revoke ALL sessions for the user (immediate, server-side).
      await tx.delete(sessionTable).where(eq(sessionTable.userId, me.id));
      // 2) Mark the account deleted (requireSession rejects it from here on).
      await tx
        .update(users)
        .set({ accountStatus: 'deleted' })
        .where(eq(users.id, me.id));
    });

    // 3) AFTER commit: enqueue the purge job (worker hard-deletes content + row).
    await enqueuePurgeAccount({ userId: me.id, requestedAt: new Date().toISOString() });

    // §12: there is no `account_deleted` name in the closed §12 set, so we record
    // the user-initiated deletion REQUEST as a content-free operational aggregate
    // (`cleanup_job_result` job='account-deletion-requested'); the worker's
    // purge-account job emits the purge-completion aggregate. No content/PII.
    emitAccountDeletionRequested({ userId: me.id });

    reply.code(204).send();
  });
};

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505).
 *
 * Drizzle wraps the underlying postgres.js error in a DrizzleQueryError whose own
 * `.code` is undefined — the real SQLSTATE (and `constraint_name`) live on
 * `err.cause`. We therefore walk the cause chain and match EITHER the 23505 code
 * OR the username unique-index name, so a concurrent duplicate-username claim
 * returns a clean 409 instead of bubbling to a 500.
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  // Bound the walk so a cyclic cause chain can't loop forever.
  for (let depth = 0; cur != null && depth < 8; depth++) {
    if (typeof cur === 'object') {
      const e = cur as { code?: string; constraint_name?: string };
      if (e.code === '23505') return true;
      if (e.constraint_name === 'users_username_uq') return true;
    }
    cur = (cur as { cause?: unknown })?.cause;
  }
  return false;
}
