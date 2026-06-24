# twenty4 — Rebuild Plan (v2)

> Status: planning doc. Supersedes the ad-hoc "slice 1–9" build on `phase-1-foundation`.
> Authoritative product source: `reference/twenty4_Development_Spec.md` (which supersedes `reference/mobile app PRD.md` on any conflict). This doc is the **build sequencing** layer on top of that spec.

---

## 0. Why rebuild

The first build grew organically and hit avoidable structural pain late:

- **Expo Go vs native-module mismatch** — `react-native-background-upload` doesn't exist in Expo Go, surfaced as a runtime crash (`startUpload` undefined) only when testing on-device. We bolted on a fallback after the fact.
- **Upload transport churn** — went through blob+XHR → ArrayBuffer rejection → `expo-file-system` streaming, discovered one error at a time on the device.
- **Networking discovered late** — presigned URLs pointed at `127.0.0.1`, unreachable from the phone; only found when testing on real hardware over Tailscale.
- **Content-type parsing** — Fastify 415s on any non-JSON body; found in production-ish testing, not design.
- **No isolation of the hard parts** — upload + montage render are the two riskiest subsystems and were not proven before features depended on them.

**This plan front-loads every one of those.** Each milestone ends with an explicit on-device (Android) acceptance check, and the two riskiest subsystems (upload, render) are isolated and proven before anything is built on top.

---

## 1. Locked decisions

| Decision | Choice | Notes |
|---|---|---|
| Language | **TypeScript everywhere** | No Python anywhere, including the render/beat-detection layer (see §6 open decisions). |
| Runtime / package manager | **Bun** | Workspaces, `bun run`, `bun test`, `bunfig.toml`. Caveat below. |
| API framework | **Fastify** on Bun | |
| Shared types | `packages/contracts` | Zod DTOs + error taxonomy, imported by API and mobile. |
| DB | **PostgreSQL + Drizzle** | UUIDv4 PKs, all `timestamptz` UTC, hard-delete (no soft-delete for content). |
| Auth | **Better Auth** | Phone OTP for MVP; email/Apple/Google later. Apple Sign-In mandatory once any social login ships. |
| Object storage | **S3-compatible** (MinIO local) | Presigned direct-PUT, no public-read ever. |
| Job queue | **BullMQ + Redis** | render, validate, cleanup, expire, notify jobs. |
| Render | **Swappable `Renderer` interface** | Stub renderer for MVP → Remotion single-worker → Remotion Lambda (Phase 3). |
| Mobile | **Expo (Expo Go first)** | Android-first. iOS deferred. Dev-client introduced only when native features (background upload) are needed. |
| Scope | **Full product**, sequenced so MVP core loop comes first | MVP cutline marked below. |

**Bun caveat (must stay explicit):** Bun runs the **API, packages, scripts, tests**. Two subsystems still require **Node** under the hood:
- **Expo / Metro** bundling (Bun can't fully run Metro).
- **Remotion** rendering (Node-based).
Both are fine — Node is the engine for those two layers only; everything else is Bun.

**Expo Go caveat (must stay explicit):** the spec *recommends bare RN* for native camera, media-library metadata, background upload, push, and save-to-gallery. We are deliberately choosing **Expo Go first** for fast Android iteration, accepting these consequences for MVP:
- Uploads are **foreground/streaming** (`expo-file-system`), not background/resumable. Background upload is a Phase-3 milestone behind a dev-client.
- In-app camera uses **`expo-camera`** (works in Expo Go); advanced capture controls deferred.
- Push uses **`expo-notifications`** (works, with Expo's push service) until the dev-client lets us go native.
- Save-to-gallery uses **`expo-media-library`**.
If any of these prove insufficient on-device, the escape hatch is the dev-client milestone (M13), pulled earlier if needed.

---

## 2. The product in one paragraph

twenty4 is a private-friend-group app. You capture/upload photos & videos during *today* (a 4am→4am window in device-local time); the server **auto-generates a 30-second 9:16 montage**; you review, remove clips, and **publish to one or more private groups**; friends react and comment; **all server content is hard-deleted 24h after publish.** The magic is the automatic montage + the ephemerality. There is no product without the montage, so it is in MVP — but behind a stub renderer first so the loop can be validated before the heavy render tech is stood up.

---

## 3. Architecture map

```
apps/
  mobile/            Expo (Expo Go first, Android-first)
services/
  api/               Fastify on Bun — stateless REST/JSON, auth-gated
  worker/            BullMQ consumers (render, validate, cleanup, expire, notify) — Node for Remotion
packages/
  contracts/         Zod DTOs + error taxonomy (shared)
  db/                Drizzle schema + migrations
infra (local, no Docker per existing setup):
  Postgres, Redis, MinIO
```

**Data model (11 tables + audit_log)** — from spec §8, build verbatim:
`user`, `group`, `group_invite`, `group_member`, `daily_media_item`, `montage`, `montage_group_visibility`, `reaction`, `comment`, `report`, `block`, `audit_log`.

**The two decoupled pipeline contracts** (build these as interfaces from day one):
- **Intelligence**: `analyze(track, clips) -> EDL` where `EDL = { durationMs:30000, aspect:"9:16", musicId, segments:[{mediaRef,inMs,outMs,transition,overlay?}] }`.
- **Renderer**: `render(EDL) -> { videoPath, thumbnailPath, durationMs, status }`.
Intelligence and Renderer are deliberately swappable. MVP ships a trivial Intelligence (chronological, fixed cuts) + a stub Renderer (ffmpeg concat/slideshow). Phase 2 swaps in beat-sync Intelligence + Remotion Renderer **without touching the API or job contracts**.

---

## 4. Milestones

Each milestone: **Goal · Steps · Deliverable · Android acceptance check**. Spec-phase tag in brackets ([P1]=Internal Alpha, [P2]=Closed Beta, [P3]=Public Launch).

### M0 — Bun monorepo foundations  [P1]
- **Goal:** repo + tooling locked; Android device can reach the dev backend.
- **Steps:** Bun workspaces; `packages/contracts` + `packages/db` scaffolds; ESLint/Prettier/tsconfig; `bunfig.toml`; `.env.example`; local Postgres/Redis/MinIO start scripts (no Docker, matching existing machine setup); **prove an Android device hits a `GET /health` over LAN/Tailscale with a hello-world ping.**
- **Deliverable:** `bun run dev` boots API; phone gets `200 /health`.
- **Acceptance (Android):** real device shows the ping response. *(This is the networking lesson from v1 — proven first, not last.)*

### M1 — API skeleton  [P1]
- **Goal:** a correct, boring Fastify-on-Bun base that won't surprise us later.
- **Steps:** health route; **DB connectivity verified on boot** (fail fast); Drizzle wired; global **error envelope** + error taxonomy in `contracts`; **content-type parser correct for all bodies** (the v1 415 lesson); CORS incl. PATCH/PUT/DELETE preflight; request logging; rate-limit scaffold.
- **Deliverable:** typed error responses; DB-verify on boot; content-type regression test.
- **Acceptance:** API test suite green; non-JSON body never 415s spuriously.

### M2 — Auth  [P1]
- **Goal:** phone-OTP sign-in end to end.
- **Steps:** Better Auth wired to our Postgres; phone OTP; dev OTP transport (log/console); session middleware; `POST /auth/start|verify|refresh|logout`, `POST /users`, `PATCH /users/me`, `DELETE /users/me`.
- **Deliverable:** session issuance + `requireSession` guard.
- **Acceptance:** contract tests for OTP happy-path + guarded route 401.

### M3 — Groups & membership  [P1]
- **Goal:** private groups + invite/join.
- **Steps:** `group`, `group_invite`, `group_member` tables; create group; invite link/code (**7-day OR 25-use expiry, owner-revocable**); preview invite; join; list members; leave; owner-remove; rename; group photo. Role enum kept (owner/admin/member), owner-only management for MVP.
- **Deliverable:** routes from spec §8 Groups block.
- **Acceptance:** two test users — one creates+invites, other joins via code; authz enforced.

### M4 — Storage & media upload pipeline  [P1]  ⚠️ risk-isolated
- **Goal:** prove direct-to-storage upload **on the Android device** before any UI depends on it.
- **Steps:** MinIO buckets (`raw-media` private short-TTL, `montages` ~25h, `thumbnails`); **presigned PUT with LAN/Tailscale-safe endpoint config** (host the phone actually connects to — the v1 lesson); `POST /media/upload-url`, `POST /media`, `GET /media/today`, `DELETE /media/{id}`; `daily_media_item` with **4am→4am day_bucket persisted on the row** (don't recompute at read); validation hierarchy (EXIF DateTimeOriginal → media-library timestamp → file creation → reject); enforce limits (≤60s video, ≤50/day, ≤200MB, JPG/PNG/HEIC, MP4/MOV).
- **Deliverable:** a documented init→PUT→complete sequence + a tiny throwaway device harness that PUTs a real file from the phone to MinIO and back.
- **Acceptance (Android):** real photo + real video uploaded from the device and re-fetched via signed GET. *(Upload is subsystem-risk #1 — proven in isolation here.)*

### M5 — Mobile shell  [P1]
- **Goal:** Expo Go app on Android with auth + groups wired to the LAN backend.
- **Steps:** Expo app boots in Expo Go on Android; expo-router; typed API client (consumes `contracts`); `EXPO_PUBLIC_*` env for backend URL; auth screens (phone OTP, profile create); groups screens (create, invite, join, members).
- **Deliverable:** sign in → create/join group, all on-device.
- **Acceptance (Android):** full auth + group flow works in Expo Go.

### M6 — Capture & today bucket  [P1]
- **Goal:** get media into today's bucket from the device.
- **Steps:** in-app camera via `expo-camera` (photo+video, switch, flash, captured-thumb strip — **this is a missing-design screen, build it**); gallery import via `expo-image-picker`; today view (list, remove item, "enough to generate?" state); upload progress UI on top of M4's transport (streaming progress + retry).
- **Deliverable:** capture/import → uploaded → visible in today bucket.
- **Acceptance (Android):** capture a video in-app + import a photo, both land in today's bucket with progress shown.

### M7 — Montage pipeline v1 (stub renderer)  [P1]  ⚠️ risk-isolated
- **Goal:** generate → review → publish, with the **render subsystem proven end-to-end behind a stub**.
- **Steps:** BullMQ+Redis; `worker` service; **`Renderer` + `Intelligence` interfaces**; **stub implementations** (chronological EDL + ffmpeg concat/slideshow to a real 9:16 30s mp4 + thumbnail); `POST /montages` → status=generating → enqueue → 202 → client polls `GET /montages/{id}`; status machine (not_generated→generating→draft_ready→published→…); **render failure → auto-retry once → user-facing retryable error**; 5-min hard timeout; no orphaned S3 objects; review screen (preview, expiry info, group selection, regenerate, remove media + regen); **generating/progress screen (missing-design — build it)**; `POST /montages/{id}/publish` to multiple groups via `montage_group_visibility`; one recap per user/group/day.
- **Deliverable:** a real (if dumb) 30s montage generated server-side and published.
- **Acceptance (Android):** capture → generate → review → publish, watch the produced mp4 on-device. *(Render is subsystem-risk #2 — the queue/worker/status/timeout/retry machinery is fully exercised here; only the *quality* of the render is stubbed.)*

### M8 — Feed + reactions + comments  [P1]
- **Goal:** the social half of the loop.
- **Steps:** `GET /feed?group=&cursor=` (chronological, 10/page, expired/blocked hidden, authz on membership); feed card (avatar, name, date, expiry countdown, 30s video autoplay-muted, counts, preview); reactions (like/laugh/fire/heart/shocked, one-per-user replaceable); comments (add/delete own, preview); group filter.
- **Deliverable:** published recaps appear in friends' feeds; react + comment work.
- **Acceptance (Android):** two devices/users — A publishes, B sees it in feed, reacts, comments; A sees counts.

> ## ──────── 🧪 THIN CORE LOOP COMPLETE ────────
> **Sign in → join group → capture → upload → auto-montage (stub) → publish → friend sees it → react/comment.** Fully on Android via Expo Go. This is the earliest point the product is *demonstrably the product*. Validate it's fun before going further.

### M9 — Ephemerality: expiry & deletion contract  [P1]
- **Goal:** the 24h hard-delete contract — the other half of what makes twenty4 *twenty4*.
- **Steps:** `expire-montage` job (24h after publish → delete video+thumb from S3, delete row, cascade reactions+comments, write audit_log tombstone); raw-media purge after publish+60-min grace (used+unused); day-window-close cleanup for unpublished raw; account-deletion purge; replace-before-expiry (`POST /montages/{id}/replace` hard-deletes prior montage+reactions+comments); S3 lifecycle rules as defense-in-depth; signed-URL TTL ≤ remaining content lifetime; cleanup jobs monitored.
- **Deliverable:** nothing survives past its contract; audit trail without content.
- **Acceptance:** a published recap + its reactions/comments + raw media are provably gone after expiry (test with shortened TTLs); replace flow purges the old one.

> ## ════════ ✅ MVP / PHASE 1 (INTERNAL ALPHA) COMPLETE ════════
> Full spec Phase 1: auth · groups · invite/join · capture+upload · montage (stub) · review · publish · feed · react/comment · delete own · **24h expiry+deletion** · minimal admin (add a thin admin in M9/M12). The loop is validated for *fun* and *ephemerality*. **Everything below extends toward the full product.**

---

### M9.5 — Moments (experimental)  [post-MVP probe]
- **Goal:** validate whether prompted, synchronized capture beats free-form capture — *before* committing to the full-product track. Opt-in only, fully measurable, removable.
- **Steps:** per-timezone scheduler fires **5–6 synced prompts/day** (default 6, server-tunable) in a waking-hours window; **minimal push** bundled here (expo-notifications + tokens + a `dispatch-moment` job — reused by M11); **2-min capture window**, late-flagged, miss = gap; the day's moments **are** the montage source (existing M7 review/edit/publish on top); per-user opt-in toggle; analytics to compare opted-in vs normal flow.
- **Acceptance:** opted-in Android device gets a prompt → captures in-window → it becomes a montage clip → publishes; non-opted-in users unaffected; opt-in / capture-completion / publish rates are queryable.
- **Flag:** remote push may not work in Expo Go (recent SDKs) → start with on-device local-notification fallback, move to a dev build (M13) if signal is promising.
- **Full plan:** `reference/milestones/M9.5-moments-experimental.md`.

---

### M10 — Real montage: Remotion + beat-sync  [P2]
- **Goal:** swap the stub for the actual magic — **no API/job-contract changes**.
- **Steps:** stand up Remotion single-worker render (`renderMedia`, queue-fed, Node); real **Intelligence**: TS/WASM beat detection (§6 decision) + per-clip heuristic scoring (motion/sharpness/face/brightness) + beat-aligned cutting → EDL; theme styling (Chill/Party/Clean/Travel/Random/Fast Cut/Soft); music picker from licensed library (~15 bundled tracks, no user audio); transitions/overlays; validate on **50 mixed items + a track** (spec Appendix A gate).
- **Acceptance:** generated montages are beat-synced, themed, and pass spec §7.5 quality validation; p50 <60s / p95 <120s.

### M11 — Push notifications & reminders  [P2]
- **Goal:** bring users back.
- **Steps:** `expo-notifications` + push tokens; events (capture reminder, recap-ready, friend posted, friend reacted, friend commented, expiring soon, invite received); reminder scheduling (timezone-aware); controls (enable/disable, reminder time, mute group, mute interactions); `dispatch-notification` job.
- **Acceptance (Android):** scheduled capture nudge + a friend-posted push both arrive on-device.

### M12 — Moderation, admin & analytics  [P2]
- **Goal:** safety + ops + measurement.
- **Steps:** report (montage/comment/user), block/unblock, blocked-can't-interact; minimal admin web (user search, suspend/ban, review reports, remove content, failed-job view, storage usage, growth metrics); analytics SDK with the **fixed event schema** (spec §12) — no content in payloads; ops events (upload_failed, render_failed, render_duration_ms, cleanup_job_result, etc.).
- **Acceptance:** report→admin-action round-trip; block prevents interaction; analytics events fire with correct (content-free) payloads.

---

### M13 — Dev-client + background/resumable upload  [P3]
- **Goal:** production-grade uploads beyond Expo Go's foreground limit.
- **Steps:** introduce custom **dev-client** (`expo-dev-client`); link `react-native-background-upload` (RN New-Arch wiring / config plugin / native registration); resumable + background uploads with the streaming path as graceful fallback; per-item retry hardening.
- **Acceptance (Android):** upload continues with app backgrounded; resumes after interruption.

### M14 — iOS parity  [P3]
- **Goal:** App Store readiness.
- **Steps:** iOS device testing; **Apple Sign-In (mandatory)** + Google + email providers; HEIC/MOV handling; iOS upload module (VydiaRNFileUploader); push via APNs; save-to-gallery.
- **Acceptance:** full loop on a real iPhone; multi-provider auth works.

### M15 — Launch hardening  [P3]
- **Goal:** ship.
- **Steps:** privacy policy + ToS + data-safety disclosures (external/legal critical path — start early); production monitoring/alerting on cleanup + render jobs; **scalable rendering (Remotion Lambda** via the same `Renderer` interface); load/perf pass (cold-start <2.5s, feed p95 <1.5s); security pass (authz on every media/feed request, signed-URL TTLs, rate limits, invite-abuse); store submission.
- **Acceptance:** perf + security targets met; builds submitted to both stores.

---

## 5. Risk-isolation summary (the v1 lessons, mapped)

| v1 failure | Where this plan kills it |
|---|---|
| Native module missing in Expo Go | §1 Expo Go caveat sets foreground-upload expectation up front; native upload is an explicit, isolated milestone (M13) behind a dev-client. |
| Upload transport churn | M4 proves the exact transport on a real Android device **before** any UI (M6) depends on it. |
| Loopback URL unreachable from phone | M0 proves device↔backend networking on day one; M4 bakes LAN/Tailscale-safe presign config in. |
| Fastify 415 on non-JSON | M1 fixes content-type parsing as a foundational step with a regression test. |
| Render complexity discovered late | M7 proves the full queue/worker/status/retry/timeout machinery behind a stub; M10 swaps in Remotion with **zero contract change**. |
| Ephemerality bolted on | M9 makes the 24h hard-delete contract a first-class milestone with test-verified purging. |

---

## 6. Open decisions to make before/within the relevant milestone

- **Beat detection in TS (no Python).** Spec says "aubio/librosa-class" — those are Python/C. To honor TS-only, pick a JS/WASM option (e.g. `music-tempo`, `web-audio-beat-detector`, or an `essentia.js`/`aubio` WASM build). **Decide before M10.**
- **Stub renderer tech.** ffmpeg (binary, TS-callable via `fluent-ffmpeg`) for M7's concat/slideshow — confirm ffmpeg is acceptable as a binary dependency. **Decide before M7.**
- **Music licensing vendor** (licensed catalog API vs bought royalty-free pack). Blocks content + store approval. Assumption: ~15 bundled royalty-free tracks. **Decide before M10.**
- **`processing_status` vs `validation_status` overlap** on `daily_media_item` (spec has two enums with overlapping values) — reconcile into one clear state machine. **Decide in M4.**
- **Feed window vs calendar day** — a recap published at 11pm lives into the next calendar day; feed must key on the expiry window, not calendar date. **Resolve in M8.**
- **Remotion Company License** (~$100/mo once team >3) — budget item, not a blocker. **Track for M10.**
- **Report retention window** — how long a reported montage snapshot is kept past 24h for moderation (legal). Assumption: ≤7 days then purge. **Decide in M12.**
- **Contact-discovery privacy** (hashing of uploaded contacts) — unspecified. **Decide before building contact discovery (P1/P2 onboarding).**

---

## 7. Suggested branch strategy

- This plan lives on `main` (`reference/REBUILD_PLAN.md`).
- Rebuild happens on a fresh branch (e.g. `rebuild/v2`) off `main`; the old `phase-1-foundation` work stays as a reference/salvage source (auth wiring, upload transport learnings, analytics schema are all reusable).
- One branch per milestone or per spec-phase, your call; each merges only after its Android acceptance check passes.
```
