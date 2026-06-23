# M3 — Groups & membership

> Spec phase: P1 · Depends on: M0 (foundations), M1 (API skeleton: error envelope, content-type, CORS, rate-limit scaffold), M2 (Better Auth sessions + `requireSession` guard) · Branch commit: one squashed commit on `rebuild/v2`

## 1. Goal

A signed-in user can create a private group, mint an owner-revocable invite code (valid for **7 days OR 25 uses**, whichever first), and any other signed-in user can preview that invite and join. Every group-scoped read/write is authorized against active membership: a non-member gets a clean `403`. This milestone is **backend-only** — the mobile group screens land in M5.

## 2. Scope

- **In scope:**
  - Tables: `group`, `group_invite`, `group_member` (with the `role` enum `owner/admin/member` and member `status` enum `active/left/removed`).
  - Group CRUD: create, list-mine, get-one, patch (rename + group photo), delete (owner-only, soft-archives or hard-deletes per §11 decision).
  - Invites: create (code unique, URL-safe, `expires_at = now + 7d`, `max_uses = 25`), revoke (owner-only, sets `revoked_at`).
  - Invite preview: `GET /invites/{code}` returns group name/photo/member-count **without** joining and **without** requiring membership (auth-gated only).
  - Join: `POST /invites/{code}/join` — atomic, race-safe `use_count` increment + membership insert.
  - Members: list members of a group (members-only); owner-remove a member; self-leave.
  - Multiple-group membership (a user may belong to many groups; `PK(group_id,user_id)` makes one membership per pair).
  - Role enum **kept** in the schema but **owner-only management** in MVP (admins do not yet wield powers — Q12).
  - Authz helper `assertMemberOf(groupId, userId)` → `403 NOT_A_MEMBER` for non-/non-active members; `assertOwnerOf` → `403 NOT_OWNER`.
  - Per-endpoint rate limiting on invite **create** and invite **join** (abuse prevention, Q11 / spec §8 cross-cutting).
- **Explicitly out of scope (and owner milestone):**
  - All mobile group screens (create / invite-share / join / member-management / list / detail) → **M5 (mobile shell)**.
  - Deep-link / universal-link invite handling on device → **M5** (this milestone only mints + validates the `code`).
  - Admin-role powers beyond owner (promote/demote, admin-remove) → post-MVP (kept in enum, not wired).
  - Group-scoped content (media, montages, feed, reactions) — those resources just *consume* `assertMemberOf` later in **M4/M7/M8**.
  - Block-relationship filtering on group reads → **M8/M12** (membership authz only here).
  - Contact-discovery-driven invites → deferred (P1/P2 onboarding, §6 open decision).

## 3. Tasks (ordered checklist)

- [ ] Add `group`, `group_invite`, `group_member` tables + the `group_role`, `group_status`, `group_member_status` pgEnums to `packages/contracts/src/db/` (and ensure `enums.ts` is in the drizzle-kit `schema` set so `CREATE TYPE` is emitted).
- [ ] Generate + check in the migration; confirm `PK(group_id,user_id)` on `group_member`, `unique(code)` on `group_invite`, and supporting indexes (`group_member.user_id` for list-mine; partial index on live invites).
- [ ] Add Zod DTOs + the error-taxonomy codes (`NOT_A_MEMBER`, `NOT_OWNER`, `INVITE_NOT_FOUND`, `INVITE_EXPIRED`, `INVITE_USED_UP`, `INVITE_REVOKED`, `ALREADY_MEMBER`, `GROUP_NOT_FOUND`, `CANNOT_REMOVE_SELF`, `CANNOT_REMOVE_OWNER`) to `packages/contracts`.
- [ ] Write the authz helpers `assertMemberOf` / `assertOwnerOf` as a shared module (single source — no per-route reimplementation; this is the §5 bypass learning).
- [ ] Implement `POST /groups` — creates group, inserts creator as `owner`/`active` membership **in one transaction**.
- [ ] Implement `GET /groups` (mine) — only groups where caller has an `active` membership.
- [ ] Implement `GET /groups/{id}` — `assertMemberOf`, returns group + caller's role + member count.
- [ ] Implement `PATCH /groups/{id}` — owner-only; rename and/or set `photo_url` (validate URL/asset ref).
- [ ] Implement `DELETE /groups/{id}` — owner-only.
- [ ] Implement `POST /groups/{id}/invites` — owner-only; generate collision-checked URL-safe code; set `expires_at`/`max_uses`/`use_count=0`; **rate-limited**.
- [ ] Implement `DELETE /groups/{id}/invites/{id}` — owner-only revoke (idempotent set of `revoked_at`).
- [ ] Implement `GET /invites/{code}` — auth-gated preview; resolves validity (revoked / expired / used-up) and returns group summary, never joins.
- [ ] Implement `POST /invites/{code}/join` — **race-safe**: single conditional `UPDATE ... SET use_count = use_count + 1 WHERE code = $1 AND revoked_at IS NULL AND expires_at > now() AND use_count < max_uses RETURNING ...`, then upsert membership; `ALREADY_MEMBER` short-circuits *without* consuming a use; **rate-limited**.
- [ ] Implement `GET /groups/{id}/members` — members-only list.
- [ ] Implement `DELETE /groups/{id}/members/{userId}` — owner-only; reject self-removal (`CANNOT_REMOVE_SELF`) and owner-removal (`CANNOT_REMOVE_OWNER`); set membership `status=removed`.
- [ ] Implement `POST /groups/{id}/leave` — caller leaves (`status=left`); owner cannot leave without transfer (flag in §11; default: reject `OWNER_CANNOT_LEAVE`).
- [ ] Register routes under the group module; wire `requireSession` on all; wire invite rate-limits.
- [ ] Delete the dead `safetyModule`-style stubs pattern from the start (do not re-introduce empty modules — §6 recap).
- [ ] Write the live-stack integration suite (§7) and get it green.

## 4. Data model & migrations

Tables touched (verbatim from spec §5, cosmetic singular naming):

- **`group`** — `id` PK (uuid) · `name` · `photo_url` (nullable) · `owner_id` FK→user · `status` enum(`active`,`archived`) · `created_at`.
- **`group_invite`** — `id` PK · `group_id` FK · `code` **unique**, short, URL-safe · `created_by` FK→user · `expires_at` (= created + 7d) · `max_uses` (default **25**) · `use_count` (default 0) · `revoked_at` (nullable). *Validity rule (Q11):* invalid if `revoked_at` set OR `now() > expires_at` OR `use_count >= max_uses`.
- **`group_member`** — `group_id` FK · `user_id` FK · `role` enum(`owner`,`admin`,`member`) · `joined_at` · `status` enum(`active`,`left`,`removed`) · **PK(`group_id`,`user_id`)**. *MVP:* only `owner` exercises management powers (Q12).

Enums: `group_status`, `group_role`, `group_member_status` — all in `enums.ts`, included in the drizzle-kit schema set.

Indexes: `unique(group_invite.code)`; `group_member(user_id)` (for `GET /groups` mine); partial index on `group_invite(group_id) WHERE revoked_at IS NULL` for active-invite lookup; the `PK(group_id,user_id)` covers membership existence checks and is the **concurrency guard** for join (the unique PK makes double-insert a no-op/conflict).

Migration name: `00XX_groups.sql` (next sequential after the M2 auth migrations). No CHECK constraints that conflict with multi-step creators (§5/§9 recap); enforce "owner is a member" via the create transaction, not a deferred CHECK.

## 5. API endpoints

All require a valid session (`requireSession`) unless noted; all errors use the `{ error: { code, status, message } }` envelope.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/groups` | session | Create group; creator becomes `owner` (one txn). |
| GET | `/groups` | session | List groups the caller is an `active` member of. |
| GET | `/groups/{id}` | member | Group detail + caller role + member count. |
| PATCH | `/groups/{id}` | owner | Rename and/or set group photo. |
| DELETE | `/groups/{id}` | owner | Delete/archive the group. |
| POST | `/groups/{id}/invites` | owner · rate-limited | Mint invite code (7-day / 25-use). |
| DELETE | `/groups/{id}/invites/{id}` | owner | Revoke invite (sets `revoked_at`). |
| GET | `/invites/{code}` | session | **Preview** group before join (no membership required, no join side-effect). |
| POST | `/invites/{code}/join` | session · rate-limited | Atomically consume a use + join the group. |
| GET | `/groups/{id}/members` | member | List active members. |
| DELETE | `/groups/{id}/members/{userId}` | owner | Owner-remove a member (not self, not owner). |
| POST | `/groups/{id}/leave` | member | Caller leaves the group. |

## 6. Mobile (Expo Go, Android)

**None.** All group screens (List, Detail, Create, Invite/Share, Join, Member management — spec §9 Groups) are built in **M5 (mobile shell)**, consuming the typed API client + `contracts` DTOs from this milestone.

## 7. Tests (live-stack)

Integration tests against real Postgres (via `app.inject` / live HTTP), two seeded users **U_owner** and **U_joiner**:

- **Create + invite + preview + join happy path:** U_owner `POST /groups` → owner membership exists; `POST /groups/{id}/invites` → code returned; U_joiner `GET /invites/{code}` previews (correct group name/member-count, **no** membership created, `use_count` unchanged); `POST /invites/{code}/join` → U_joiner is now `active` member, `use_count == 1`; `GET /groups` for U_joiner now lists the group.
- **Authz 403 for non-member:** a third user with no membership gets `403 NOT_A_MEMBER` on `GET /groups/{id}` and `GET /groups/{id}/members`; non-owner gets `403 NOT_OWNER` on PATCH/DELETE/invite-create/invite-revoke/member-remove.
- **Concurrent-join race (the phase-1 test):** fire N parallel `POST /invites/{code}/join` from N distinct users against an invite with `max_uses = 25` (and a second run with a tiny cap, e.g. 2). Assert `use_count` **never exceeds `max_uses`**, exactly `min(N, max_uses)` memberships are created, and surplus joiners get `INVITE_USED_UP` — no overshoot, no lost update (the conditional `UPDATE ... WHERE use_count < max_uses RETURNING` is what's being proven).
- **Removal-authz cannot be bypassed (§5 learning):** non-owner cannot remove any member (`403 NOT_OWNER`); owner cannot remove self (`CANNOT_REMOVE_SELF`) or the owner row (`CANNOT_REMOVE_OWNER`); a removed member (`status=removed`) immediately fails `assertMemberOf` on subsequent group reads (`403`). Assert a removed-then-bypass attempt (re-using a stale session / forging the path) still 403s.
- **Invite expiry — time:** with an invite whose `expires_at` is in the past, both `GET /invites/{code}` and `POST /invites/{code}/join` return `INVITE_EXPIRED`; no membership/use consumed.
- **Invite expiry — use-count:** an invite at `use_count == max_uses` rejects further joins with `INVITE_USED_UP`.
- **Invite revoke:** owner `DELETE`s the invite; subsequent preview + join return `INVITE_REVOKED`; revoke is idempotent (second revoke does not error).
- **Re-join / already-member:** an active member calling join returns `ALREADY_MEMBER` and does **not** consume a use; a previously-`left` member can re-join (consuming a use), reactivating membership.
- **Rate-limit:** rapid invite-create and invite-join bursts beyond the configured cap return the rate-limit error code (cap env-configurable for CI determinism — the §5 OTP-cap learning applied to invites).

## 8. Acceptance criteria

- Migration applies cleanly; `group`/`group_invite`/`group_member` + enums exist with `unique(code)` and `PK(group_id,user_id)`.
- All §7 live-stack tests green, including the **concurrent-join race** (no `use_count` overshoot) and the **removal-authz-bypass** cases.
- `assertMemberOf` is the single shared gate; every group-scoped route calls it (or `assertOwnerOf`) — no inline ad-hoc membership checks.
- Invites honor the 7-day / 25-use / owner-revocable rule exactly; preview never joins; join is atomic.
- Error envelope used consistently for every failure path.
- **Android device check:** from a real Android device on LAN/Tailscale (the M0 networking path), using a session token obtained via the M2 auth flow and `curl`/HTTP from the device (or the M0 ping harness extended): U_owner creates a group + mints an invite; U_joiner previews then joins via the `code`; `GET /groups` on the joiner's device shows the group; a non-member request returns `403`. (No UI yet — this verifies the endpoints are reachable + correct from the device that M5 will build on.)

## 9. Dependencies & prerequisites

- **M2 complete:** Better Auth sessions + `requireSession` guard + a way to obtain two distinct authenticated test users (dev OTP transport).
- **M1 complete:** error envelope + taxonomy, `'*'` content-type parser, CORS method list, rate-limit scaffold (reused for invite caps).
- **M0 complete:** live Postgres reachable; device↔backend networking proven for the acceptance check.
- `packages/contracts` consuming `user` table (FK targets) from M2.
- Env: invite rate-limit caps configurable (`INVITE_CREATE_CAP`, `INVITE_JOIN_CAP` or similar) for CI determinism.

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md)

- **§5 group member-removal authz bypass — build the gate in from the start.** The phase-1 slice-4 hardening pass found member-removal could be bypassed; here `assertOwnerOf` is a single shared helper enforced on every management route, with explicit self-/owner-removal guards and a regression test that a removed member is immediately locked out (recap §5 "every feature slice shipped a functional then a hardening commit").
- **§5 throttle gaps — rate-limit invite endpoints from the start (Q11 abuse prevention).** Invite create + join are rate-limited up front, with the cap **env-configurable for CI** (directly applying the recap's per-IP OTP-cap fix to invites; §5 "OTP test flakiness").
- **§5 concurrent correctness — the conditional-UPDATE join.** Apply the implement→adversarial-verify→fix loop (§5/§8.11): the join's `use_count` increment is a single atomic conditional `UPDATE ... WHERE use_count < max_uses RETURNING`, not read-then-write, so the concurrent-join race cannot overshoot — proven by the phase-1 race test.
- **§5/§9 no DEFERRABLE CHECKs.** Enforce "owner is a member" via the create transaction (app layer), not a PG CHECK — PG CHECKs can't be DEFERRABLE and broke better-auth's multi-step create in v1.
- **§9 migration hygiene.** Include `enums.ts` in the drizzle-kit `schema` so the role/status pgEnums emit as `CREATE TYPE`.
- **§6 delete dead code from the start.** Do not scaffold empty/unregistered modules (the v1 `safetyModule` smell); ship only wired routes.
- **§4 single shared authz module.** Centralize `assertMemberOf`/`assertOwnerOf` so later milestones (M4 media, M7 montage, M8 feed) reuse one correct gate rather than re-deriving membership checks.

## 11. Open decisions / flags

- **Group delete semantics:** hard-delete vs archive (`status=archived`). **Default:** soft-archive (`status=archived`) for MVP to avoid cascade complexity before content tables exist; flip to hard-delete cascade once M4–M9 lifecycle jobs are in. Revisit when group-owned content lands.
- **Owner leaving / ownership transfer:** there is no transfer endpoint in MVP. **Default:** owner cannot `leave` (`OWNER_CANNOT_LEAVE`); owner must `DELETE` the group. Transfer is a post-MVP item (kept implicit by the `role` enum).
- **Invite code length/charset:** **Default:** ~10-char base62 URL-safe, collision-checked on insert. Tune for unguessability vs shareability.
- **Re-join after removal:** a `removed` member re-joining via a valid code — **Default:** allowed (reactivates to `active`, consumes a use); owner can re-remove. Flag if removed should be a hard block.
- **Member count source:** computed live vs denormalized counter on `group`. **Default:** computed live (count of `active` memberships) for correctness; denormalize only if it shows up as a hot path.
- **Admin role activation:** `admin` exists in the enum but is inert in MVP (Q12). No endpoint promotes to admin yet.
