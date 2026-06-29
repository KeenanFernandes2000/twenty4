// Postgres enums (pgEnum) live here and are deliberately included in the
// drizzle-kit `schema` glob (drizzle.config.ts) so that adding a pgEnum later
// emits a `CREATE TYPE` in the generated migration. In v1 a missing enums.ts in
// the schema glob meant pgEnums were never emitted — see PHASE1_WORK_RECAP.md §5.
//
// M0 scaffolds the file with one trivial placeholder enum to prove the wiring.
// Real domain enums land per-milestone from M2.
import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Placeholder enum from M0 — proves drizzle-kit emits `CREATE TYPE` from this file.
 * Kept (not dropped) so migration generation produces a clean additive diff; it
 * already exists in the live DB from 0000_init.
 */
export const scaffoldStatus = pgEnum("scaffold_status", ["ok"]);

/**
 * How a user first authenticated / which provider owns the account.
 * Social providers (apple, google) are interface-stubbed in P1, wired in M14.
 */
export const authProvider = pgEnum("auth_provider", ["phone", "email", "apple", "google"]);

/**
 * Account lifecycle state. The M2 session-create gate only mints a session for
 * `active`; suspended/banned/deleted are rejected with a 403 envelope code.
 */
export const accountStatus = pgEnum("account_status", ["active", "suspended", "banned", "deleted"]);

// ── M3 groups ────────────────────────────────────────────────────────────────
/**
 * Group lifecycle. `DELETE /groups/{id}` soft-archives (status=archived) per the
 * M3 §11 default — hard-delete cascade waits until content tables (M4–M9) land.
 */
export const groupStatus = pgEnum("group_status", ["active", "archived"]);

/**
 * Membership role. `admin` exists in the enum but is inert in MVP (Q12) — only
 * `owner` exercises management powers. Kept so post-MVP promote/transfer is a
 * data change, not a migration.
 */
export const groupRole = pgEnum("group_role", ["owner", "admin", "member"]);

/**
 * Membership lifecycle. `active` is the only state that satisfies assertMemberOf;
 * `left` (self-leave) and `removed` (owner-removed) are both inactive and can be
 * reactivated by re-joining via a valid invite (consumes a use).
 */
export const groupMemberStatus = pgEnum("group_member_status", ["active", "left", "removed"]);

// ── M4 media ─────────────────────────────────────────────────────────────────
/** What kind of media this item is. */
export const mediaType = pgEnum("media_type", ["photo", "video"]);

/**
 * The NARROW validation verdict (M4 §11). Distinct from processing_status: this
 * is just "did the validate-media job approve this item?" — `pending` until the
 * worker runs, then a terminal `valid` | `invalid`.
 */
export const validationStatus = pgEnum("validation_status", ["pending", "valid", "invalid"]);

/**
 * The LIFECYCLE state machine (M4 §11). Authoritative transition path:
 *   uploaded → validating → valid | invalid → used → deleted
 *   (→ failed on any infra error at any step)
 * `validation_status` is the narrow verdict the lifecycle *reads* to move from
 * `validating` to `valid`/`invalid`. Both enums are kept for spec fidelity; revisit
 * collapsing to one in M7 when `used` is exercised by the render pipeline.
 *  - uploaded:   row created at POST /media init (presigned PUT issued)
 *  - validating: /complete passed the HeadObject gate, validate-media enqueued
 *  - valid:      validate-media approved (validation_status=valid)
 *  - invalid:    validate-media rejected (validation_status=invalid) OR /complete gate reject
 *  - used:       consumed by a montage render (M7)
 *  - deleted:    hard-deleted (DELETE /media/:id) — row is actually removed, this
 *                state is only ever transient/for completeness
 *  - failed:     infra error (S3/Redis/db) — distinct from `invalid` (a verdict)
 */
export const processingStatus = pgEnum("processing_status", [
  "uploaded",
  "validating",
  "valid",
  "invalid",
  "used",
  "deleted",
  "failed",
]);

// ── M7 montage ─────────────────────────────────────────────────────────────────
/**
 * Montage theme — drives per-theme pacing/transition/overlay in the EDL builder
 * (M7 §2). The montage row stores `theme` as `text`; this pgEnum exists so
 * drizzle-kit emits a documented `CREATE TYPE`. The matching z.enum lives in
 * dto/montageEnums.ts (`themeEnum`) — the two value lists are hand-kept in sync.
 */
export const theme = pgEnum("theme", ["chill", "party", "clean", "travel", "random", "fast_cut", "soft"]);

/**
 * Montage lifecycle status machine (M7 §2/§4):
 *   not_generated → generating → draft_ready → published
 * side-branches → failed; deleted_by_user / removed_by_admin / expired reserved
 * for M8/M9. Backs `montage.status`. Matching z.enum in dto/montageEnums.ts
 * (`montageStatusEnum`) — keep in sync.
 */
export const montageStatus = pgEnum("montage_status", [
  "not_generated",
  "generating",
  "draft_ready",
  "published",
  "failed",
  "deleted_by_user",
  "removed_by_admin",
  "expired",
]);

// ── M8 social ──────────────────────────────────────────────────────────────────
/**
 * Reaction kind — the one replaceable reaction a user sets on a montage (M8 §4).
 * Backs `reaction.type`. Matching z.enum in dto/social.ts (`reactionTypeEnum`) —
 * keep both value lists in sync.
 */
export const reactionType = pgEnum("reaction_type", ["like", "laugh", "fire", "heart", "shocked"]);

/**
 * Comment lifecycle. M8 soft-deletes (status=deleted) so counts/preview update
 * instantly and the row survives for M9's atomic cascade/audit at expiry. Backs
 * `comment.status`. Matching z.enum in dto/social.ts (`commentStatusEnum`) — sync.
 */
export const commentStatus = pgEnum("comment_status", ["active", "deleted"]);
