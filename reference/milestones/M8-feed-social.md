# M8 — Feed + Social (reactions & comments)
> Spec phase: P1 · Depends on: M2 (auth/sessions), M3 (groups + membership authz), M7 (montage publish + `montage_group_visibility`) · Branch commit: one squashed commit on `rebuild/v2` ("M8: block-filtered feed + reactions + comments — THIN CORE LOOP complete")

> **✅ DONE on `rebuild/v2` (squashed commit `6645277`) — device-accepted (2026-06-29).** The two-device §8 flow was run on-device (A publishes → B sees the autoplay-muted recap, reacts/comments → A sees the counts → block A↔B hides A's recap from B) and accepted. Migration `0006_mute_red_shift` (block + reaction + comment tables/enums) applied. The missing `block` table (an M3 prerequisite never built) was added here; its write-API stays M12 (M8 only reads/seeds it). All 6 endpoints live: `GET /feed` (keyset, block-filtered both directions, expiry>now), reactions (replaceable upsert), comments (soft-delete, rate-limited), each gated by no-leak `canViewMontage` (null→404). Mobile feed/player/comments screens with web-safe native-video split. **Gate: tsc clean (contracts/api/api-client/worker); 178 backend tests pass / 0 fail (incl. 19 feed live-stack tests + the real 72.5s Remotion render); `expo export --platform web` clean (38 routes).** Adversarial review verdict SHIP (no HIGH/MED); 3 LOW items fixed (rate-limit-after-validation + 2 test-hardening). §11 comment decisions locked (text ≤500, POST ≤10/min, reaction set/clear ≤30/min, preview = 2 latest). **🧪 THIN CORE LOOP complete.** Next: M9 (ephemerality — the `ON DELETE CASCADE` FKs added here back M9's expiry reap).

## 1. Goal
The **social half of the loop** is live: a member opens the app and sees a **block-filtered, chronological feed** of friends' published-and-unexpired recaps (10 cards/page, keyset pagination), each card autoplaying its 30s montage **muted** with a tap-for-sound player; they can **react** (one replaceable reaction from like/laugh/fire/heart/shocked) and **comment**, and the publisher sees the live counts. With M7's publish in place, the **thin core loop is now demonstrable end-to-end on two Android devices**: A captures → generates → publishes; B sees it in feed, reacts, comments; A sees the counts.

## 2. Scope
- **In scope:**
  - **`GET /feed?group=&cursor=`** — chronological **keyset (seek) pagination**, **10 cards/page**, returns only montages that are `published`, **unexpired** (`expiry_at > now()`), visible to the caller via `montage_group_visibility` on a group the caller is a **member** of, and whose author is **not blocked by, and has not blocked, the caller** (both directions). Optional `group` filter scopes to a single group the caller belongs to.
  - **`canViewMontage(viewerId, montageId)` authz helper** — single reusable predicate: montage is `published` **and** unexpired **and** shares ≥1 group the viewer is a member of (via `montage_group_visibility` ∩ viewer's `group_member`) **and** no `block` row exists in **either** direction between viewer and author. Returns the montage row or `null`; **`null` → 404** (no-leak: never distinguish "exists but hidden" from "doesn't exist"). Used by feed, the player fetch, reactions, and comments endpoints.
  - **Feed card data contract** (per spec §9 Feed + Comments, §7.6 perf): author **avatar**, **display name**, recap **date** (`day_bucket`), **expiry countdown** (derived from `expiry_at`), **30s 9:16 video** (signed playback URL, autoplay-**muted** preview, tap-for-sound), **thumbnail** (poster), **reaction count** (+ the viewer's own current reaction type, if any), **comment count**, **comment preview** (latest 1–2 visible comments, block-filtered), and **report/delete affordances** (delete shown only on the viewer's own montage; report on others' — wiring the affordance/flags only; the report/block *write* endpoints are M12).
  - **Reactions:** `POST /montages/:id/reactions` (upsert — one row per `(montage_id, user_id)`, replaceable type) and `DELETE /montages/:id/reactions` (remove the caller's reaction). `reaction.type ∈ {like,laugh,fire,heart,shocked}`. Authz via `canViewMontage` (can't react to what you can't see).
  - **Comments:** `GET /montages/:id/comments` (list `status='active'`, **block-filtered in BOTH directions** — hide comments authored by anyone the viewer blocks or who blocks the viewer), `POST /montages/:id/comments` (add; rate-limited), `DELETE /comments/:id` (**delete own only**; soft-set `status='deleted'` so counts/preview exclude it — hard-delete happens at montage expiry in M9). All gated by `canViewMontage` on the parent montage.
  - **Block-filtering applied to comments in BOTH directions** (the §5 learning) — at the feed-card preview, the comments list, and comment counts.
  - **Group filter** on the feed.
  - **`reaction` + `comment` tables** (+ supporting indexes) added to `packages/contracts`.
  - **Mobile (Expo Go, Android):** feed screens **3.x** — `index` (vertical scroll feed, autoplay-muted in-view preview, tap-for-sound), montage **player**, and **comments** screen/sheet.
- **Explicitly out of scope (and which later milestone owns it):**
  - **Block / unblock / report *write* endpoints** (`POST /blocks`, `DELETE /blocks/:userId`, `GET /users/me/blocks`, `POST /reports`) and the admin moderation surface → **M12**. M8 *consumes* `block` rows for filtering and renders the report/delete *affordances*, but the create/delete-block + report APIs and the moderation console are M12. (Tests seed `block` rows directly.)
  - **Hard-deletion / cascade** of reactions & comments at expiry, the `expire-montage` job, raw-media purge, replace-flow → **M9**. M8's comment delete is a soft `status='deleted'`; physical row removal is M9's cascade.
  - **Push notifications** for "friend posted / reacted / commented" → **M11**.
  - **`recap_watch` / `feed_viewed` / `reaction_sent` / `comment_sent` analytics emission** (§12) → wired in **M12** (analytics milestone); M8 only ensures the data exists to count.
  - **Real montage *quality*** — still the M7 stub renderer; M8 plays whatever M7 produced. Real Remotion/beat-sync → **M10**.
  - **Likes-on-comments / threaded replies / @mentions** — not in spec scope.

## 3. Tasks (ordered checklist)
- [ ] **Schema:** add `reaction` and `comment` tables to `packages/contracts/src/db/schema/` (+ the `reaction_type` and `comment_status` pgEnums in `enums.ts`); add indexes (see §4). Generate migration `00xx_feed_social`.
- [ ] **Enums/DTOs in contracts:** `reactionType` zod enum (`like|laugh|fire|heart|shocked`), feed DTOs (`FeedCard`, `FeedPage { items, nextCursor }`), `Comment` DTO, reaction/comment request bodies. Cursor codec (see §5 cursor design).
- [ ] **`canViewMontage(viewerId, montageId)` helper** in the api authz layer — one query (or small set) implementing the 4-clause predicate; returns the montage row or `null`. Unit-test the no-leak contract.
- [ ] **Shared block-filter predicate** — a reusable SQL fragment / helper `notBlockedBetween(viewerId, otherUserId)` (NOT EXISTS a `block` row in either direction) used by feed, comments list, and comment preview.
- [ ] **`GET /feed`** route: `requireSession`; validate `group?` (uuid, must be a group the caller is a member of else 403) and `cursor?` (**malformed → 422, never 500**); keyset query ordered by `(published_at DESC, id DESC)`, `LIMIT 11` (fetch n+1 to compute `nextCursor`); join author, `montage_group_visibility`, `group_member` (caller), exclude blocked-either-direction, exclude expired; assemble `FeedCard`s (signed video + thumbnail URLs with **TTL ≤ remaining content lifetime**, reaction count + viewer's reaction, comment count, block-filtered comment preview, `canDelete`/`canReport` flags).
- [ ] **`POST /montages/:id/reactions`**: `requireSession`; `canViewMontage` → 404 if null; validate `type`; **upsert** on `(montage_id,user_id)` (`ON CONFLICT … DO UPDATE SET type, created_at`); rate-limit; return new count + viewer's type.
- [ ] **`DELETE /montages/:id/reactions`**: `requireSession`; `canViewMontage` → 404; delete caller's row (idempotent — 204/200 even if none); return updated count.
- [ ] **`GET /montages/:id/comments`**: `requireSession`; `canViewMontage` → 404; list `status='active'`, **block-filtered both directions**, keyset-paginated (`created_at ASC, id ASC`, malformed cursor → 422); include author avatar/name.
- [ ] **`POST /montages/:id/comments`**: `requireSession`; `canViewMontage` → 404; validate `text` (non-empty, max length); **rate-limit** (per spec §11 — comment endpoint); insert `status='active'`; return the comment + new count.
- [ ] **`DELETE /comments/:id`**: `requireSession`; load comment; **403 unless `comment.user_id === viewer`**; set `status='deleted'` (soft); return updated count.
- [ ] **Cursor codec:** opaque base64url of the sort tuple; decode wrapped in try/catch → on any failure throw the `VALIDATION` (422) error, **never let it bubble to a 500**. Add a regression test for a garbage cursor string.
- [ ] **api-client:** typed methods `getFeed`, `setReaction`, `clearReaction`, `getComments`, `addComment`, `deleteComment` consuming the contracts DTOs.
- [ ] **Mobile 3.x screens:** feed `index` (vertical FlatList, in-view autoplay-muted via `expo-av`/`expo-video`, tap-for-sound, expiry countdown, react bar, comment-count tap → comments), montage **player** (full-screen, sound on), **comments** sheet/screen (list + composer + delete-own).
- [ ] **Group filter UI:** chip/segmented control at feed top → re-query with `?group=`.
- [ ] **Live-stack tests** (see §7) green.
- [ ] **Android device acceptance** (two users/devices) per §8.
- [ ] Squash → one commit on `rebuild/v2` after the Android check passes.

## 4. Data model & migrations
**New tables** (per spec §5 — build verbatim):

- **`reaction`** — `id` uuid PK (`gen_random_uuid()`) · `montage_id` uuid FK→`montage` · `user_id` uuid FK→`user` · `type` `reaction_type` enum(`like,laugh,fire,heart,shocked`) · `created_at` timestamptz default now() · **`UNIQUE(montage_id, user_id)`** (one replaceable reaction per user per montage).
- **`comment`** — `id` uuid PK · `montage_id` uuid FK→`montage` · `user_id` uuid FK→`user` · `text` text (non-empty, length-capped at app layer) · `created_at` timestamptz default now() · `status` `comment_status` enum(`active,deleted`) default `active`.

**New enums** (in `enums.ts` so drizzle-kit emits `CREATE TYPE`): `reaction_type`, `comment_status`.

**Indexes:**
- `reaction (montage_id)` — count + aggregate per montage.
- `comment (montage_id, created_at)` where `status='active'` — preview + list + count.
- (FK indexes on `user_id` for both, for block-join filtering and cleanup.)

**FKs / cascade note:** declare FKs to `montage`/`user`; the **physical cascade-delete on expiry is M9's job** (defense-in-depth: explicit job + DB-level `ON DELETE CASCADE` as backstop — wire the `ON DELETE CASCADE` here so M9's montage-row delete reliably reaps reactions/comments).

**Migration:** `00xx_feed_social` (enums + 2 tables + indexes). No changes to `montage` / `montage_group_visibility` / `block` (all created earlier; M8 only reads them).

## 5. API endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/feed?group={uuid}&cursor={opaque}` | session | Chronological keyset page (10/card) of visible, unexpired, block-filtered published recaps; optional single-group filter. |
| POST | `/montages/:id/reactions` | session | Upsert the caller's one reaction (`type` in body); 404 via `canViewMontage`. |
| DELETE | `/montages/:id/reactions` | session | Remove the caller's reaction (idempotent); 404 via `canViewMontage`. |
| GET | `/montages/:id/comments?cursor=` | session | List active, block-filtered (both directions) comments; 404 via `canViewMontage`. |
| POST | `/montages/:id/comments` | session | Add a comment (rate-limited); 404 via `canViewMontage`. |
| DELETE | `/comments/:id` | session | Soft-delete (`status='deleted'`) **own** comment only; 403 otherwise. |

**Conventions:** every error uses the `{ error: { code, status, message } }` envelope. **Malformed/undecodable `cursor` → 422 (`VALIDATION`), never 500.** Hidden/expired/non-existent montage → **404** (no-leak). Group the caller isn't in → **403**. Signed playback/thumbnail URL **TTL ≤ remaining content lifetime** (`expiry_at − now()`).

## 6. Mobile (Expo Go, Android)
Feed screens **3.x** (consuming the typed api-client; Ember dark tokens):
- **`app/(tabs)/feed/index.tsx` (3.1 — Feed):** vertical `FlatList` of feed cards. Each card: author avatar + display name, recap date, **expiry countdown** (live ticking), **30s video autoplay-muted** when on-screen (`onViewableItemsChanged` viewability → play in-view / pause off-screen; thumbnail as poster until ready), **tap-for-sound** (tap toggles mute / opens player), reaction bar (5 emoji, highlight viewer's current pick, tap to set/replace, tap-again to clear), reaction count, comment count + preview (1–2 latest, block-filtered), report/delete affordance (delete only on own card). Group filter chip row at top. Empty-feed + loading-skeleton + error+retry states (global 7.x states from M5). Infinite scroll via `nextCursor`.
- **`app/feed/[montageId]/player.tsx` (3.2 — Player):** full-screen 9:16 playback with **sound on**, scrubber, expiry countdown, react/comment access.
- **`app/feed/[montageId]/comments.tsx` (3.3 — Comments):** list (block-filtered) + composer (rate-limit-aware, optimistic add) + **delete-own** swipe/long-press. Opened from a card's comment-count tap.
- **api-client** methods wired; react-query for feed pages/comments with cache invalidation on react/comment.

*Note (§5/§7 recap): video autoplay+sound is a native-only path — verified on-device, not in headless CI.*

## 7. Tests (live-stack)
Integration against real Postgres/Redis/MinIO via `app.inject`, seeding rows directly (two users **A** and **B**, a shared group, a published unexpired montage by A):
- **Feed happy-path:** A publishes; **B (member) sees A's montage in `GET /feed`**; card carries avatar, display name, date, expiry countdown field, signed video URL, reaction count (0), comment count (0).
- **Reactions round-trip:** B `POST …/reactions {type:'fire'}` → count 1, viewer reaction `fire`; B re-reacts `heart` → still count 1, type now `heart` (**replaceable, one-per-user**); **A's feed card shows reaction count 1**; B `DELETE …/reactions` → count 0.
- **Comments round-trip:** B `POST …/comments` → comment listed, **A's card comment count = 1** + preview shows it; B `DELETE /comments/:id` (own) → count 0 / excluded; A attempting `DELETE` B's comment → **403**.
- **Block hides montage (both directions):** seed `block(A→B)` → B's feed **omits A's montage**, and `GET …/comments` / reactions on it → **404** (`canViewMontage` null). Seed instead `block(B→A)` → same result (symmetric).
- **Block hides comments (both directions):** A's montage has comments by B and C; seed `block(viewer↔B)` (each direction in separate cases) → viewer's comments list and the card preview/count **exclude B's comments** while keeping C's.
- **Authz:** non-member of the montage's group → `GET /feed?group=` for that group **403**; direct reaction/comment on a montage they can't see → **404** (no-leak; never 200/403-leak).
- **Keyset pagination:** 25 published montages → page 1 returns 10 + `nextCursor`; following cursors walk chronologically with no dupes/gaps; final page has no `nextCursor`.
- **Malformed cursor → 422 NOT 500:** garbage/truncated/non-base64 `cursor` on `/feed` (and `/comments`) returns **422 `VALIDATION`**, asserted explicitly (the §5 learning).
- **Expired hidden:** a montage past `expiry_at` is absent from feed and yields 404 on its sub-resources.
- **Reaction-type validation:** invalid `type` → 422.

## 8. Acceptance criteria
- `GET /feed` returns only **published, unexpired, member-visible, block-clean** montages, **10/page**, keyset-paginated; group filter scopes correctly; non-member group → 403.
- `canViewMontage` returns `null`→404 for every hidden/expired/blocked/non-existent case (no-leak), and gates reactions + comments.
- Reactions are **one-per-user, replaceable**; counts update on A's view; comments add/list/**delete-own** work; **block-filtering hides montage and comments in BOTH directions**.
- **Malformed cursor → 422, never 500** (regression-tested).
- All §7 live-stack tests green.
- **Android device check (the thin-core-loop demo, two devices/users):** User **A** captures → generates (M7 stub) → **publishes**; User **B** on a second device opens the feed, **sees A's recap card autoplay muted**, taps for sound / opens the player, **reacts** (and changes the reaction), and **comments**; **A refreshes and sees the reaction + comment counts**. Then seed a block A↔B and confirm B's feed no longer shows A's recap. *(This is the earliest point twenty4 is demonstrably the product — validate it's fun before M9.)*

## 9. Dependencies & prerequisites
- **M7 complete:** a real (stub-rendered) published montage with `montage_group_visibility` rows, `published_at`/`expiry_at` set, and signed playback/thumbnail URLs available.
- **M3 complete:** `group` / `group_member` for membership authz; `block` table **exists** (created in the schema; write-API is M12 but the table & FKs must be present for filtering + test seeding).
- **M2 complete:** `requireSession` guard + user identity (avatar/display_name on `user`).
- **M1:** error envelope/taxonomy (incl. `VALIDATION` 422, `NOT_FOUND` 404, `FORBIDDEN` 403), `'*'` content-type parser, CORS method list, rate-limit scaffold (reused for comment/reaction limits).
- **Libs:** `expo-av` (or `expo-video`) for in-feed autoplay-muted + player; `@tanstack/react-query` for paged caching; `expo-router`. (`npx expo install --fix` to pin SDK-correct versions — don't guess.)
- **Env:** signed-URL config from M4 (presign host = the host the device connects to, LAN/Tailscale-safe).

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md)
- **§5 — block-filter comments in BOTH directions.** A naive "hide comments by users I blocked" misses "users who blocked me." Apply the symmetric `notBlockedBetween` predicate to feed visibility, the comment list, the card preview, **and** comment counts. (Tests assert both directions.)
- **§5 — malformed cursor must 422, not 500.** Decode the opaque cursor inside try/catch and translate any failure to a `VALIDATION` (422); never let a decode/parse throw bubble to a generic 500. Explicit regression test for garbage input.
- **§5 (no-leak authz) — `canViewMontage` returns null→404**, never distinguishing "exists but you can't see it" from "doesn't exist," so block/membership state isn't probeable.
- **§8.4 — presigned PUTs can't gate, but reads must honor lifetime:** signed playback/thumbnail URL TTL ≤ remaining content lifetime (`expiry_at − now()`) so a leaked feed URL dies with the content (spec §6.227).
- **§5/§7 — device-only paths:** video autoplay-muted + tap-for-sound + in-view playback toggling are native paths verified on-device, not in headless CI — they're in the Android acceptance, not the live-stack suite.
- **§8.5 — front-door hardening already in place (M1):** the `'*'` content-type parser keeps RN/Expo POST bodies (reaction/comment) from spurious 415s; reuse it, don't re-add.
- **§5 — implement → adversarial-verify → harden rhythm:** expect the no-leak / both-direction-block cases to be where the first pass is wrong; budget the verify pass.

## 11. Open decisions / flags
- **Feed window vs. calendar day (REBUILD_PLAN §6):** a recap published at 11pm lives into the next calendar day — **feed keys on `expiry_at > now()` (the live window), not `day_bucket`/calendar date.** *Resolved here:* visibility = `published ∧ expiry_at > now()`; `day_bucket` is display-only on the card. (Locked.)
- **Comment delete semantics:** M8 uses **soft `status='deleted'`** (so counts/preview update instantly and the row survives for M9's atomic cascade/audit at expiry). *Default: keep soft-delete in M8; M9 owns the hard cascade.* (Flag if M9 prefers immediate hard-delete on user comment-delete — current default: no, defer to expiry.)
- **Comment length / rate limits:** spec §11 mandates rate-limiting comments but not exact numbers. **✅ LOCKED (2026-06-26): `text` ≤ 500 chars; comment POST ≤ 10/min/user.** (reaction set/clear ≤ 30/min/user remains the default — reaction rate not separately confirmed.) Env-configurable, mirroring the §5 OTP-cap-configurable lesson for deterministic CI.
- **Comment preview depth:** **✅ LOCKED (2026-06-26): 2 latest** active+block-clean comments on the card.
- **Reaction count shape:** spec card shows a single reaction count; *default* return total count + viewer's own type (not the per-type breakdown). Per-type breakdown deferred unless design needs the emoji tally.
- **Report/delete affordance only (no write API):** M8 renders `canReport`/`canDelete` flags; the actual `POST /reports` + block writes are **M12**. Flag if product wants report wired earlier.
