// Feed authorization (M8 §10) — the no-leak visibility predicate + the symmetric
// block filter, in ONE place so the feed page query, the player fetch, reactions,
// and comments all agree on what a viewer may see.
//
//  - canViewMontage: the 4-clause predicate (published ∧ unexpired ∧ shares a group
//    the viewer is an active member of ∧ no block in EITHER direction). Returns the
//    montage row or null. null → 404 at the route (never distinguish "hidden" from
//    "missing" — block/membership state must not be probeable).
//  - requireCanView: convenience that 404s on null (reactions + comments routes).
//  - notBlockedBetween: the reusable both-direction block fragment (the §10 learning
//    — filtering ONE direction misses "users who blocked me"). Reused by the feed
//    visibility, the comment list, the comment preview, AND the comment count.
//  - montageVisibleTo: the shared membership∩visibility EXISTS fragment, so the feed
//    keyset query and canViewMontage apply the IDENTICAL visibility rule.
import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { block, groupMember, montage, montageGroupVisibility } from "@twenty4/contracts/db";
import { MontageNotFoundError } from "@twenty4/contracts";
import type { DbClient } from "../db.ts";

export type MontageRow = typeof montage.$inferSelect;

// NOT EXISTS a `block` row in EITHER direction between the viewer and the other
// user (the §10 symmetric filter). `viewerId` is the caller's literal id; the other
// side may be a literal id OR a correlated column (e.g. `montage.userId`,
// `comment.userId`) so the SAME fragment serves the per-row feed/comment filters.
export function notBlockedBetween(viewerId: SQLWrapper | string, otherUserId: SQLWrapper | string): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${block}
    WHERE (${block.blockerUserId} = ${viewerId} AND ${block.blockedUserId} = ${otherUserId})
       OR (${block.blockerUserId} = ${otherUserId} AND ${block.blockedUserId} = ${viewerId})
  )`;
}

// EXISTS a montage_group_visibility row for THIS montage in a group the viewer is
// an ACTIVE member of (optionally scoped to a single group). Correlates on the
// outer `montage.id`, so it drops into both the single-row canViewMontage check
// and the feed page query unchanged.
export function montageVisibleTo(viewerId: string, groupId?: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${montageGroupVisibility} mgv
    JOIN ${groupMember} gm ON gm.group_id = mgv.group_id
    WHERE mgv.montage_id = ${montage.id}
      AND gm.user_id = ${viewerId}
      AND gm.status = 'active'
      ${groupId ? sql`AND mgv.group_id = ${groupId}` : sql``}
  )`;
}

// The 4-clause no-leak predicate as ONE round-trip. Returns the montage row when
// the viewer may see it, else null. The owner viewing their OWN published montage
// passes (they're an active member of the group they published into; no self-block).
export async function canViewMontage(
  db: DbClient,
  viewerId: string,
  montageId: string,
): Promise<MontageRow | null> {
  const rows = await db.db
    .select()
    .from(montage)
    .where(
      and(
        eq(montage.id, montageId),
        eq(montage.status, "published"),
        sql`${montage.expiryAt} > now()`,
        montageVisibleTo(viewerId),
        notBlockedBetween(viewerId, montage.userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// canViewMontage + 404 on null. Used by reactions + comments so a blocked/expired/
// hidden/missing montage ALL return the identical MONTAGE_NOT_FOUND (no leak).
export async function requireCanView(db: DbClient, viewerId: string, montageId: string): Promise<MontageRow> {
  const row = await canViewMontage(db, viewerId, montageId);
  if (!row) throw new MontageNotFoundError();
  return row;
}
