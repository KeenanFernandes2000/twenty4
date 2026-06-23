# M9 — Ephemerality: the 24h hard-delete contract
> Spec phase: P1 · Depends on: M0–M8 (esp. M4 storage/upload, M7 montage+worker/BullMQ, M8 feed/reactions/comments) · Branch commit: one commit on `rebuild/v2` (the last MVP commit — **MVP / Phase-1 Internal Alpha completes here**)

## 1. Goal
Nothing survives past its contracted lifetime. A published recap and **all** of its reactions, comments, raw source media, S3 video + thumbnail are **provably and irrecoverably gone** once it expires (24h after publish), and **no content survives a deliberately-dropped job** — proven by the spec §6 deletion suite (happy paths + 6 lost-job regressions) running against the live stack with shortened TTLs. Only content-free audit tombstones remain. This is a hard correctness gate, treated exactly like the M7 render gate: it does not pass until the §6 suite is green, and the recap's lesson (§5: *the deletion gate failed on first attempt*) is pre-empted by building every backstop from the start.

## 2. Scope
- **In scope:**
  - **`expire-montage` job** — fires 24h after publish (delayed BullMQ job, jobId scheduled on publish). On fire: S3-first delete (video + thumbnail), then hard-delete the `montage` row, **cascade-delete its `reaction` + `comment` + `montage_group_visibility` rows**, write a **content-free `audit_log` tombstone** — all atomic (single DB tx for the row work; S3 deletes precede the tx so a crash leaves only orphaned-but-already-deleting S3 objects, never a live row pointing at gone media).
  - **Raw-media purge after publish + 60-min grace** — on successful publish, schedule purge of **all** `daily_media_item` rows for that `day_bucket` (used **and** unused) + any draft renders, +60 min. Deletes S3 raw object then the row.
  - **Day-window-close cleanup for unpublished raw** — when a `day_bucket` window closes (4am local) with **no publish**, purge that day's raw media (S3 + rows).
  - **`purge-account` job** — on `DELETE /users/me`: immediately purge **all** of the user's content (raw media, montages + their video/thumb S3 objects, reactions, comments, visibility rows, the user's reactions/comments on *others'* montages), write tombstone, then delete the user. Better Auth sessions revoked.
  - **Replace-before-expiry** — `POST /montages/:id/replace`: generate a new montage; on the **new montage's successful publish**, hard-delete the prior montage + its reactions/comments/visibility/S3 objects (Q2), and record a **supersede chain** (`superseded_by` pointer) so the prior is unambiguously dead. The replace must not leave the prior montage reachable by the expiry sweep (§5 regression #1).
  - **Defense-in-depth repeatable sweeps** (reclaim from LOST delayed jobs — the authoritative backstop):
    - `sweep-expiries` (~3 min) — find any `published` montage with `expiry_at <= now()` (or `NULL` expiry while published — see CHECK) still alive → run the same delete path.
    - `raw-purge-sweep` (~3 min) — find raw media past its purge-due time (published+grace, or window-closed) still alive → purge.
    - `day-close-sweep` (~30 min) — find closed-window day_buckets with surviving unpublished raw → purge.
    - `snapshot-purge-sweep` (~30 min) — find `report` content snapshots past their retention window (default +7d) still alive → strip/purge the snapshot (the §5 slice-8 PII hole).
  - **S3 lifecycle rules as a backstop** — `raw-media` short TTL; `montages` + `thumbnails` ~25h safety TTL. Belt-and-suspenders behind the app jobs (spec §6 enforcement layer 1).
  - **Signed-URL TTL clamped ≤ remaining content lifetime** — presign expiry = `min(default_ttl, expiry_at - now())`; expired/deleted content → old signed URL returns 404.
  - **DB CHECK** (`published ⇒ expiry_at NOT NULL`) so a NULL-expiry published montage can never exist to slip the sweep (§5 regression #4).
  - **Content-free tombstones via a metadata sanitizer** — a single `sanitizeAuditMetadata()` chokepoint guarantees `audit_log.metadata` carries no media paths, no comment/reaction text, no PII — only ids, counts, action, reason codes.
  - **`audit_log` table** (already in the 11+1 model from M1 migrations) — written on every deletion/expiry/purge/replace/admin action.
  - A **thin admin** view of failed/lost cleanup jobs (the REBUILD_PLAN note "add a thin admin in M9/M12") — read-only failed-job list + storage-usage count, enough to *see* a lost job; full admin is M12.
- **Explicitly out of scope (owner milestone):**
  - Beat-synced / real Remotion render quality — **M10** (M9 runs against the M7 stub render; deletion semantics are render-agnostic).
  - Push "expiring soon" reminder — **M11** (the *countdown* UI exists from M8; the *push* is M11).
  - Full moderation/admin console, report→action workflow UI, analytics dashboard — **M12** (M9 ships only the audit tombstone + a read-only lost-job/storage view + the snapshot-purge sweep that M12's report flow depends on).
  - Report content-retention *policy* tuning (the 7-day window value is a §13 business decision) — M9 builds the sweep with the assumed 7-day default; the number is confirmable in **M12**.

## 3. Tasks (ordered checklist)
- [ ] **Schema/CHECK:** confirm `montage` has CHECK `(status <> 'published' OR expiry_at IS NOT NULL)`; add if missing (new migration). Confirm `montage.superseded_by` (self-FK nullable) + `source_media_ids` exist. Confirm `audit_log` table + partial index `(status, expiry_at) WHERE status='published'` (drives sweep). `report` has `snapshot_*` + `retain_until`.
- [ ] **Metadata sanitizer:** implement `sanitizeAuditMetadata(action, ctx) -> jsonb` — allow-listed keys only (ids, counts, action, reason code, byte/row counts); strip everything else. Unit-test it rejects text/paths/PII.
- [ ] **Deletion primitive:** `deleteMontageHard(montageId, reason)` — (1) load video/thumb paths + child counts; (2) **S3-first**: delete video + thumbnail (idempotent, treat already-gone as success); (3) **single DB tx**: delete reactions, comments, visibility rows, the montage row, insert sanitized tombstone. Crash-safe: S3 before tx; tombstone inside tx. Reused by expire, replace, account-purge, admin-remove, sweep.
- [ ] **Raw purge primitive:** `purgeRawMedia(filter, reason)` — S3-first object delete then row delete, per item, idempotent; one tombstone summarising counts.
- [ ] **`expire-montage` job:** on `publish`, enqueue delayed job at `published_at + 24h` with jobId `expire-montage-<montageId>` (**no `':'`** — §5/§10 BullMQ gotcha; delayed scheduling IS the expiry mechanism). Handler = `deleteMontageHard(id, 'expired')`, guarded to no-op if already gone/superseded.
- [ ] **Replace flow:** `POST /montages/:id/replace` → create new montage (status=generating, M7 pipeline). On **new** montage publish success: set prior `superseded_by=new.id`, then `deleteMontageHard(prior, 'replaced')`; cancel prior's delayed expire job (best-effort — sweep is the backstop). New montage gets its own +24h expiry. Idempotency key on replace/publish (M8 lever).
- [ ] **Raw-media purge on publish:** on publish success, enqueue delayed `raw-purge-<montageId>-<dayBucket>` at +60 min → `purgeRawMedia({user, dayBucket}, 'published_grace')` (used + unused + draft renders).
- [ ] **Day-window-close cleanup:** scheduled job at window close → for each user whose `day_bucket` just closed with no publish, `purgeRawMedia({user, dayBucket}, 'window_closed')`.
- [ ] **`purge-account` job:** `DELETE /users/me` → enqueue immediate purge of all user montages (`deleteMontageHard` each), all raw (`purgeRawMedia`), all reactions/comments authored on others' montages, blocks/reports as policy allows; revoke BA sessions; set `account_status=deleted`; tombstone. Returns fast; purge runs in worker, reclaimable by sweeps.
- [ ] **Reclaim sweeps (repeatable):** register 4 repeatable jobs — `sweep-expiries` (~3m), `raw-purge-sweep` (~3m), `day-close-sweep` (~30m), `snapshot-purge-sweep` (~30m). Each re-runs the matching primitive for any row past-due-but-alive. Each emits a `cleanup_job_result` analytics op-event (content-free) + tombstone on action.
- [ ] **Signed-URL clamp:** in the presign helper (M4), clamp TTL to `min(defaultTtl, max(0, expiry_at - now()))`; if content gone/expired, return 404 not a URL.
- [ ] **S3 lifecycle rules:** apply to MinIO buckets — `raw-media` short TTL, `montages`/`thumbnails` ~25h. Document as backstop-only.
- [ ] **Thin admin read view:** failed/lost cleanup-job list + storage-usage count (read-only).
- [ ] **§6 deletion suite:** write happy-paths + the **6 lost-job regressions** + shortened-TTL end-to-end (below). Gate: all green before milestone commit.
- [ ] **Android acceptance:** publish a recap with a shortened (e.g. ~2-min) lifetime on a dev build, confirm on-device it disappears from feed + its signed URL 404s after expiry; replace flow swaps the live recap.

## 4. Data model & migrations
Tables touched (no new domain tables — all from the 11+1 model built in M1):
- `montage` — relied-on columns: `status`, `published_at`, `expiry_at`, `superseded_by` (self-FK, nullable), `render_job_id`, `source_media_ids`. **Migration:** add CHECK `montage_published_expiry_chk (status <> 'published' OR expiry_at IS NOT NULL)` if not already present; ensure partial index `montage_published_status_expiry_idx ON montage(status, expiry_at) WHERE status='published'`.
- `audit_log` — `actor_id`, `action`, `target_type`, `target_id`, `metadata` jsonb (sanitized), `created_at`. Written by every deletion path.
- `daily_media_item` — `processing_status` (incl. `deleted`), `expiry_at`, `day_bucket`; rows hard-deleted by purge.
- `reaction`, `comment`, `montage_group_visibility` — cascade-deleted with their montage.
- `report` — `snapshot_*` columns + `retain_until` (default `created_at + 7d`); driven by `snapshot-purge-sweep`.
- `user` — `account_status` → `deleted` on account purge.

Migration name(s): `00XX_montage_expiry_check_and_indexes`, `00XX_report_snapshot_retention` (only the deltas not already laid down in M1/M8).

## 5. API endpoints
- `POST /montages/:id/replace` · session + owner · generate a replacement montage; on its publish, hard-delete the prior (Q2). **(new in M9)**
- `DELETE /montages/:id` · session + owner · manual hard-delete now (status `deleted_by_user`) via `deleteMontageHard`. *(wired here to the deletion primitive)*
- `DELETE /users/me` · session · triggers `purge-account`. *(wired here to the purge job)*
- `GET /montages/:id/download-url` · session + owner · presign **clamped** to remaining lifetime; 404 if expired/gone. *(clamp added here)*
- `GET /admin/cleanup-jobs` · admin guard · read-only failed/lost cleanup-job list. **(thin, new in M9)**
- `GET /admin/storage-usage` · admin guard · read-only storage count. **(thin, new in M9)**

All other content reads (`GET /feed`, `GET /montages/:id`, signed GETs) already filter expired/blocked from M8; M9 makes the *deletion* behind that real.

## 6. Mobile (Expo Go, Android)
- **Replace/republish confirmation flow** (spec §9 missing-screen #5) — wired to `POST /montages/:id/replace`; copy warns prior reactions/comments are discarded. *(built functionally in M7's review screen; confirmed live here)*
- **Account-deletion confirmation flow** (spec §9 missing-screen #6) — destructive confirm + consequence copy → `DELETE /users/me`.
- **Expiry countdown on feed/recap cards** (from M8) — verified to actually 404 / vanish at expiry, not just count down.
- No new green-field screens; M9 is mostly server-side. The two confirm flows are the device-visible surface.

## 7. Tests (live-stack)
Real Postgres + Redis + MinIO; **shortened TTLs** (expiry, grace, sweep intervals env-configurable so a "24h" expiry runs in seconds). The **§6 deletion suite**:

**Happy paths**
- **Expiry purges everything:** publish a recap (+ add reactions + comments + raw media) → advance shortened TTL/run `expire-montage` → assert montage row, video S3 object, thumbnail S3 object, all `reaction`, all `comment`, all `montage_group_visibility` rows are **gone**; a sanitized `audit_log` tombstone exists with **no content** (counts/ids only); the recap is absent from `GET /feed`; the old signed video URL returns **404**.
- **Raw purged after publish+grace:** publish → advance 60-min grace → assert all `daily_media_item` (used + unused) + draft renders + their S3 objects gone.
- **Day-close purges unpublished raw:** upload raw, never publish → close window → assert that day's raw gone.
- **Replace purges prior:** publish A (+ reactions/comments) → replace → publish B → assert A's row + S3 + A's reactions/comments gone, `superseded_by` set, B live with its own expiry.
- **Account purge cascades:** user with montages/raw/reactions/comments → `DELETE /users/me` → assert all their content gone (incl. their reactions/comments on others' montages), sessions revoked, `account_status=deleted`.
- **Signed-URL clamp:** presign TTL never exceeds remaining lifetime; post-expiry presign attempt 404s.

**The 6 lost-job regressions** (each: drop/lose the primary delayed job, prove a backstop reclaims):
1. **Replace hides prior from sweep** — replace, then *drop* the prior's expire job; `sweep-expiries` must still reclaim the superseded prior (regression: replace once orphaned it).
2. **No raw-purge backstop** — drop the +60-min raw-purge job; `raw-purge-sweep` must reclaim the raw media.
3. **Orphan draft rows** — render a draft, never publish, lose cleanup; sweep must reclaim the orphaned draft montage + its S3 objects.
4. **NULL-expiry published montage** — assert the DB CHECK makes this *unconstructible*; attempt to insert/update a `published` row with `expiry_at NULL` and assert it's rejected (so no NULL-expiry row can dodge the `expiry_at <= now()` sweep predicate; sweep also explicitly reclaims any past-due).
5. **Non-atomic tombstone** — simulate a crash between S3 delete and row delete (and between row delete and tombstone): assert no live montage row ever points at deleted S3 media, and re-running the path is idempotent and still produces exactly one sanitized tombstone.
6. **Snapshot PII retention** — a `report` snapshot past its 7-day `retain_until`; `snapshot-purge-sweep` must strip/purge it (the slice-8 hole).

**Sanitizer unit test** — `sanitizeAuditMetadata` drops any media path, comment/reaction text, raw PII; only allow-listed keys survive.

**BullMQ jobId guard** — assert all scheduled deletion jobIds use `-` not `:` (a `:` silently breaks delayed scheduling = the expiry mechanism).

## 8. Acceptance criteria
- The full **§6 deletion suite is green** on the live stack (happy paths + all 6 lost-job regressions + sanitizer + jobId guard). This is the gate; no milestone commit without it.
- With shortened TTLs: a published recap and **ALL** its reactions, comments, and raw source media are **provably gone** after expiry (rows + S3 objects), with only a content-free tombstone remaining; old signed URLs **404**.
- **Replace** purges the prior montage (+ its reactions/comments/S3), records the supersede chain, and the prior is unreachable by feed and reclaimable by sweep even if its expire job is lost.
- **Account deletion** cascades all the user's content immediately and revokes sessions.
- **No content survives a deliberately-dropped job** — every lost-job regression is reclaimed by a sweep / prevented by the CHECK.
- DB CHECK forbids a `published ⇒ NULL expiry_at` row; signed-URL TTL never exceeds remaining lifetime.
- **Android device check:** on a dev build with a shortened lifetime, publish a recap → confirm on-device it vanishes from the feed and its video URL 404s at expiry; run the replace flow and watch the live recap swap (prior gone). Account-deletion confirm flow purges and signs the user out.
- **MVP / Phase-1 Internal Alpha is complete** when this passes.

## 9. Dependencies & prerequisites
- M7 worker + BullMQ + Redis (the queue that runs expire/sweep/purge jobs; **delayed jobs** must work — the expiry mechanism).
- M7 montage publish path (sets `published_at`, `expiry_at = published_at + 24h`, enqueues the delayed expire job).
- M8 feed/reactions/comments (the children that cascade; feed already hides expired/blocked).
- M4 S3/MinIO + presign helper (delete + clamped-TTL presign; LAN/Tailscale-safe host).
- M1 schema/migrations: `audit_log`, `montage` CHECK + partial index, `report` snapshot/retain columns.
- M2 `DELETE /users/me` + Better Auth session revocation.
- Env: shortened-TTL/sweep-interval overrides for tests; S3 lifecycle rule config on the three buckets.

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md)
- **§5 / §8.7: the deletion gate FAILED on first attempt.** Build **all** backstops from the start, not after the gate fails: authoritative app jobs **+** repeatable reclaim sweeps for lost jobs **+** DB CHECK **+** atomic content-free tombstones **+** the 6 lost-job regression tests. Budget for the gate to fail once and design so it doesn't.
- **§5: the original 5 holes** — (1) replace hid the prior montage from the sweep, (2) no raw-purge backstop, (3) orphan draft rows never swept, (4) NULL-expiry montages never swept, (5) non-atomic tombstone. Each maps directly to a regression in §7. Pre-empt all five.
- **§5: the third hole (slice 8) — reported-content PII snapshots retained indefinitely** past their +7d purge. Include `snapshot-purge-sweep` from day one (regression #6).
- **§5 / §8.10: BullMQ custom jobId must NOT contain `':'`** — it silently breaks delayed-job scheduling, which **is** the 24h-expiry mechanism. Use `-`. (jobId-guard test.)
- **§6 (keep) / §8.7: S3-first-then-row delete is crash-safe** — delete S3 objects *before* the DB tx so a crash never leaves a live row pointing at gone media (only harmless orphaned-S3, which the sweep/lifecycle rule reclaims).
- **§9 / spec §6 enforcement: defense in depth** — keep S3 lifecycle rules as a backstop layer *and* signed-URL TTL clamped to remaining lifetime (a leaked URL dies with the content), with app jobs as the authoritative path.
- **§5 / §8: live-stack tests caught the real bug nearly every slice** — run the whole suite against real PG/Redis/MinIO, no mocks; flush only OTP/rate-limit Redis keys for rerun determinism.
- **§8: idempotency claim must release on op-throw** — the deletion primitives + replace/publish must be idempotent and retry-safe (re-running a partially-done delete must converge, not double-tombstone).

## 11. Open decisions / flags
- **Report content-retention window** — assumed **7 days** then purge (spec §13 #3, §5 slice-8); the value is a business/legal call, confirmable in M12. `snapshot-purge-sweep` is built to the 7-day default and the number is a single env/config knob.
- **Sweep intervals** — defaults `~3 min` (expiries, raw-purge) and `~30 min` (day-close, snapshot-purge); tune with ops data. Shorter = faster reclaim, more load.
- **Replace: cancel prior expire job vs rely on sweep** — default: best-effort cancel **and** rely on the sweep as the backstop (regression #1 proves the sweep is the real guarantee).
- **S3 `montages` safety TTL** — assumed **~25h** (1h margin over the 24h app contract) so the lifecycle rule can never delete content *before* its contracted lifetime, only after if a job is lost.
- **Thin admin surface** — M9 ships only a read-only lost-job + storage-usage view (enough to *see* a dropped job); the full moderation/admin console + report→action workflow is **M12**.
- **Account-purge timing** — default immediate (worker-async, returns fast, sweep-reclaimable); a hard synchronous purge SLA is deferred to launch hardening (M15).
