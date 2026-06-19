/**
 * Idempotency helper (§8 cross-cutting) — dedupes publish/replace so a client
 * retry (same key) returns the SAME result instead of re-running the side effects.
 *
 * Model (backed by the `idempotency_key` table, scoped per user + endpoint):
 *   - FIRST request with a key: we claim the key (INSERT), run the operation, then
 *     persist the response (status + body). Returns `{ replayed: false, ... }`.
 *   - REPLAY (same user + key + matching body hash): returns the STORED response
 *     without re-running the operation. `{ replayed: true, ... }`.
 *   - CONFLICT (same key, DIFFERENT body hash): the client reused a key for a
 *     different request → 409 idempotency_conflict (never silently mis-replays).
 *   - IN-FLIGHT race (two requests, same key, before the first stored a response):
 *     the second observes a claimed-but-unfinished key and 409s `conflict` so the
 *     caller can retry once the first completes (we don't block/poll here).
 *
 * A NATURAL-IDEMPOTENCY caller (no client key) should pass a deterministic key it
 * derives from the request (e.g. `publish:<montageId>:<sortedGroupIds>`); then a
 * re-publish to the SAME set is a no-op replay even without an Idempotency-Key
 * header. The montage publish/replace routes do exactly this.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { idempotencyKeys } from '@twenty4/contracts/db';
import { errors } from '@twenty4/contracts/errors';
import { db } from '../db/index.js';

/** Stable hash of the request body (a reused key with a different body → conflict). */
export function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

/** How long a stored idempotency record is honored before it may be GC'd. */
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

export interface IdempotentResult<T> {
  /** True when this returned a STORED response (the op did not run again). */
  replayed: boolean;
  status: number;
  body: T;
}

/**
 * Run `op` at most once per (userId, endpoint, key). On replay, return the stored
 * response. `body` is the request payload whose hash pins the key to one request.
 *
 * `op` must return the `{ status, body }` it wants cached + returned. It runs ONLY
 * on the first (claiming) call.
 */
export async function withIdempotency<T>(
  args: {
    userId: string;
    endpoint: string;
    key: string;
    body: unknown;
  },
  op: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashBody(args.body);

  // 1) Replay / conflict check against any existing record for this (user,key).
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, args.userId),
        eq(idempotencyKeys.key, args.key),
      ),
    )
    .limit(1);

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw errors.idempotencyConflict(
        'idempotency key reused with a different request',
        { endpoint: args.endpoint },
      );
    }
    if (existing.responseStatus != null) {
      // Completed earlier — replay the stored response verbatim.
      return {
        replayed: true,
        status: existing.responseStatus,
        body: existing.responseBody as T,
      };
    }
    // Claimed but no response yet → a concurrent first request is in flight.
    throw errors.conflict('a request with this idempotency key is in progress', {
      endpoint: args.endpoint,
    });
  }

  // 2) Claim the key. A UNIQUE(user,key) race means only ONE inserter wins; the
  //    loser catches the unique violation and falls back to a replay/conflict.
  try {
    await db.insert(idempotencyKeys).values({
      key: args.key,
      userId: args.userId,
      endpoint: args.endpoint,
      requestHash,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    });
  } catch (err) {
    // Lost the insert race — re-read and replay/conflict on the winner's record.
    const [winner] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, args.userId),
          eq(idempotencyKeys.key, args.key),
        ),
      )
      .limit(1);
    if (!winner) throw err; // not a uniqueness race — surface it.
    if (winner.requestHash !== requestHash) {
      throw errors.idempotencyConflict(
        'idempotency key reused with a different request',
        { endpoint: args.endpoint },
      );
    }
    if (winner.responseStatus != null) {
      return {
        replayed: true,
        status: winner.responseStatus,
        body: winner.responseBody as T,
      };
    }
    throw errors.conflict('a request with this idempotency key is in progress', {
      endpoint: args.endpoint,
    });
  }

  // 3) We hold the claim — run the operation, then persist its response. If the
  //    op THROWS, RELEASE the claim (delete the unfinished key) so the failure
  //    isn't permanently cached as an in-flight conflict — a later retry with the
  //    same key can re-run. (A completed op's response stays cached for replay.)
  let result: { status: number; body: T };
  try {
    result = await op();
  } catch (err) {
    await db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, args.userId),
          eq(idempotencyKeys.key, args.key),
        ),
      )
      .catch(() => undefined);
    throw err;
  }

  await db
    .update(idempotencyKeys)
    .set({
      responseStatus: result.status,
      responseBody: result.body as Record<string, unknown>,
    })
    .where(
      and(
        eq(idempotencyKeys.userId, args.userId),
        eq(idempotencyKeys.key, args.key),
      ),
    );

  return { replayed: false, status: result.status, body: result.body };
}
