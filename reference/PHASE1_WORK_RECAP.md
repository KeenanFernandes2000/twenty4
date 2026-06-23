# twenty4 — Phase-1 Foundation: Work Recap & Lessons Learned

> A detailed post-mortem of the `phase-1-foundation` branch — what was built, the architecture as it actually shipped, the assumptions made, every notable issue hit from planning through development, and the distilled learnings. Companion to `reference/REBUILD_PLAN.md`.
>
> **Source of truth for this recap:** the `phase-1-foundation` branch (28 commits, 2026‑06‑18 → 2026‑06‑23), its `PLAN.md` / `RUNNING.md`, the in-code markers, and the project memory notes. The product spec it was built against is `reference/twenty4_Development_Spec.md`.

---

## 0. TL;DR

The branch delivered the **complete Phase‑1 Internal Alpha** of twenty4 — the full core loop (auth → groups → capture/upload → auto-generated 30s beat-synced montage → publish → feed → react/comment → 24h hard-delete) across **9 vertical slices**, with **both hard correctness gates passed** (render §7.5, deletion §6) and **188 tests green** (contracts 27, api 132, worker 29). It was built in essentially **one ~15-hour marathon on 2026‑06‑19**, plus packaging/fixes after.

Fidelity to the plan was high. The pain was concentrated in a few predictable places:
- **Security always needed a second pass** — every feature slice shipped a "functional" commit then a "hardening" commit closing real findings.
- **The 24h deletion promise was the hardest correctness target** — its gate *failed on the first attempt* and a third hole surfaced a slice later.
- **The mobile upload subsystem had four independent failure modes**, most only discoverable on a physical device — which is exactly why it dragged into a 3-days-later "closing commit."
- **Infra/networking was bespoke** (no-Docker, no-sudo WSL box; device-over-LAN), with several foot-guns.

The rebuild (`REBUILD_PLAN.md`) front-loads exactly these.

---

## 1. What was built (scope delivered)

**All 9 slices complete; both gates passed.** End-state by package:

- **`services/api` (Fastify 5):** auth, users, groups, media, montage, feed, social, safety, admin modules. Full authz (group membership, both-direction block filtering, owner-only, admin guard), two-layer rate limiting, idempotency, strict §12 analytics firewall. **132/132 tests** (mostly live-stack integration via `app.inject` against real Postgres + MinIO + Redis, including a real Remotion render).
- **`services/worker` (BullMQ):** render pipeline (intelligence → EDL → Remotion → real h264 1080×1920 ~30s MP4) + the full deletion lifecycle (expire, sweep-expiries, cleanup-raw, raw-purge-sweep, day-close-sweep, purge-account, supersede-cleanup, snapshot-purge-sweep). **29/29 tests; deletion suite 22/22.**
- **`packages/contracts`:** the single source of truth — Drizzle schema (17 tables: 14 domain/system + 3 better-auth), Zod DTOs, strict EDL schema, enums, error taxonomy, analytics union, 4am day-window logic. **27/27 tests.** 12 checked-in migrations (0000–0011).
- **`apps/mobile` (Expo SDK 56):** every screen — auth 1.1–1.7, today/capture/montage 2.x, feed/social 3.x, groups 4.x, profile/settings 5.x, safety 6.x, global 7.x states, analytics, reminders. **All six previously-"missing" spec screens built.**
- **`apps/admin` (Vite + React):** internal moderation/ops console (login, users, reports, content, ops).
- **Dev tooling:** `scripts/dev.sh` one-command boot, `RUNNING.md`, screenshot gallery for visual QA.

**Partial / device-pending (by design, not regression):** native-only paths (camera, real EXIF metadata, video autoplay+sound, true background upload, push delivery, save-to-gallery, deep-link invites) are implemented but verifiable only on a physical device — not in headless CI. The upload-transport rework in the final commit is the one genuinely unfinished-feeling piece (real-device upload reliability was still being shaken out after alpha was declared complete).

---

## 2. As-built architecture

**Monorepo:** pnpm (`pnpm@9.15.0`) + Turborepo, Node 22, shared `tsconfig.base.json` (ES2022, strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Internal packages consumed as **TS source, no build step** (`main → src/index.ts`).

| Workspace | Purpose | Key tech |
|---|---|---|
| `services/api` | Stateless REST API | Fastify 5.8.5, better-auth 1.6.19, drizzle-orm 0.45.2, postgres.js, bullmq, ioredis, AWS S3 SDK, zod |
| `services/worker` | BullMQ jobs (validate, render, deletion) | @remotion/renderer+bundler 4.0.481, essentia.js 0.1.3, sharp, exifr, execa |
| `packages/contracts` | **Single source of truth** (schema + DTOs + EDL + enums + errors + analytics + dayWindow) | drizzle-orm/kit, zod |
| `packages/api-client` | Typed fetch client (mobile + admin) | depends only on contracts |
| `packages/config` | Shared eslint/prettier/tsconfig | eslint 9, prettier |
| `apps/mobile` | The app | Expo SDK ~56.0.12, RN 0.85.3, React 19.2.3, expo-router, zustand, react-query |
| `apps/admin` | Moderation/ops console | Vite 8 + React 19 (hash routing, no router lib) |
| `infra/remotion` | `<Montage/>` composition | remotion 4.0.481 |
| `infra/migrations` | 12 SQL migrations + drizzle meta | drizzle-kit |

> **Note:** there is no `packages/db` — the spec's "db package" is folded into `packages/contracts/src/db/`. `infra/docker/` exists but is empty.

**Stack highlights (concrete):** PostgreSQL 16 (citext) via postgres.js + drizzle-orm; Better Auth (emailOTP + phoneNumber + bearer; Apple/Google stubbed); BullMQ + Redis 7; S3-compatible storage (local MinIO, signed-URL only, 3 buckets raw/montages/thumbnails); Remotion self-hosted single worker (concurrency 1, 5-min timeout, retry-once — **no Lambda**, correctly deferred); beat detection via essentia.js WASM (DSP, no ML) with precomputed beat grids on bundled tracks.

**Data model:** all 11 spec entities present (cosmetic pluralization only) + 2 justified extras (`idempotency_key`, `analytics_aggregate`) + 3 better-auth tables. `montage` carries `edl` jsonb, `source_media_ids`, `superseded_by`, and a CHECK that `published ⇒ expiry_at NOT NULL`. Load-bearing partial indexes (e.g. `montage_published_status_expiry_idx WHERE status='published'`).

**Pipeline contracts (the good bones to keep):** algorithmic **Intelligence** (`analyze → score → EDL`) and a swappable **`Renderer` interface** (`render(edl) → {videoPath, thumbnailPath, durationMs, status}`) with `RemotionRenderer` behind it. The EDL is a `.strict()` Zod schema (1080×1920/30fps/30000ms literals, segments, beat grid, theme style, audio). Intelligence and Renderer are cleanly decoupled exactly as the spec intended — this is the single most reusable architectural decision.

---

## 3. Development chronology & process

**Planning then one sustained build burst.** Reference material + plan committed late 06‑18; **all 9 slices built in one ~15-hour marathon on 06‑19** (01:01 → 16:08), then ~2.5h of packaging/test-stability, a dev-tooling commit at 23:38, and a CORS fix just after midnight 06‑20. 25 of 28 commits land on 06‑19.

**Build order ≠ plan order.** Plan: 0→1→2→…→9. Actual: **0 → 1 → 3 → 4 → 2 → 5 → 6 → 7 → 8 → 9** — auth (3) and groups (4) were pulled ahead of native capture/upload (2). This was sanctioned by the plan's own parallelization clause; the critical-path slices (the render gate, core loop, feed, deletion gate) were never reordered.

**Every feature slice followed a `functional → hardening` two-step**, with an explicit adversarial security/correctness review between commits driving the follow-up. Tests grew monotonically (api 92→97→109→111→121→132). No reverts, no "wip", no rollbacks — trouble surfaced as planned hardening, not churn.

**Then a 3-day pause (06‑20 → 06‑23)** to a lone "closing commit" that, despite its empty message, did real work: reworking the mobile upload transport (added foreground + filesystem fallbacks) and API content-type handling — i.e. the device-side upload reliability that headless CI couldn't catch.

---

## 4. Assumptions made

| # | Assumption | Notes |
|---|---|---|
| A1 | Deliverable = full Phase-1 Internal Alpha, 9 demoable vertical slices, commit-per-slice | Held. |
| A2 | Mobile = Expo SDK 56 + **dev client** (New Arch), `expo prebuild → bare` as escape hatch | **PLAN.md said RN 0.81; actual was 0.85.3** — version guess was wrong. |
| A3 | Apple/Google social auth stubbed behind an interface; only email+phone OTP real in P1 | Still stubbed. |
| A4 | Object storage = local MinIO; R2/S3 deferred to prod | |
| A5 | Music = ~15 royalty-free placeholders w/ precomputed beat grids | Only **4 synthesized** placeholders shipped; real licensing is an open §13 decision. |
| A6 | Beat detection algorithmic (no ML): essentia.js WASM primary, node-aubio fallback | essentia.js 0.1.x → "validate early." |
| A7 | `Spool.html` is a **visual reference only** (549 KB minified) — Ember design re-implemented natively in RN | Not importable. |
| A8 | Only 3 screens genuinely undesigned (upload-progress, render-failure, replace-confirm) | Built functionally + flagged `TODO(design)`. |
| A9 | Headless Linux box: no emulator — user verifies native on a phone; agent verifies via typecheck/tests + real MP4 + Expo-web Playwright screenshots | Shaped the whole QA story. |
| A10 | Day window = 4am→4am, server-authoritative, persisted on the row, never recomputed | |
| A11 | Renderer self-hosted single worker behind swappable interface; Lambda → Phase-3 | Held. |
| A12 | Internal packages consumed as TS source, no build step | |
| A13 | Spec-gap defaults: report-content retention 7 days; `/legal/*` stub; budget Remotion license | All marked `TODO(spec-gap)`. |
| A14 | **Accepted P1 limit:** media freshness is forgeable without capture attestation (P2 fixes) | Loud flag in `validateMedia.ts`. |
| A15 | **Accepted P1 limit:** phone OTP stored plaintext at rest (Better Auth 1.6 limitation); email OTP hashed | |

---

## 5. Issues hit during development

### Infra / networking
- **No Docker / no sudo on the WSL box.** `docker-compose.dev.yml` is checked in for parity but **not used here**. Real infra is user-space: native Redis (:6379), user-space Postgres cluster `~/.twenty4-pg` on **:5433** (compose says :5432 — port divergence foot-gun), MinIO + `mc` static binaries, static ffmpeg/ffprobe — all sourced from `~/.twenty4-dev-env.sh`. `scripts/dev.sh` boots/repairs each (but **can't auto-start Redis** — needs sudo, only warns).
- **Phone can't reach `127.0.0.1`.** API must bind `0.0.0.0`; phone uses the machine LAN IP via `EXPO_PUBLIC_API_URL`.
- **WSL2 double-NAT.** Phone hits the Windows host, not WSL — needs `networkingMode=mirrored` in `.wslconfig` (+ `wsl --shutdown`) or a `netsh portproxy`.
- **MinIO flaky under test load** — media/montage tests time out when it drops; remedy is restart-to-fix.
- **Presigned URL host must match the connect host** — SigV4 signs Host, so a loopback-signed URL is unusable from the device.

### Auth (Better Auth 1.6)
- **drizzle-orm dual-copy type clash** (cost real debugging): better-auth pulls `kysely`, making `services/api` resolve a *different physical copy* of `drizzle-orm@0.45.2` than `contracts` → incompatible `PgColumn` types, tsc errors everywhere. Fix: add `kysely` devDep to `@twenty4/contracts` so both resolve the same copy; `.npmrc dedupe-peer-dependents=false`.
- **BA field mapping uses Drizzle property names, not SQL columns** (`name:'displayName'` not `'display_name'`).
- **Phone-OTP signup 500** until `signUpOnVerification.getTempEmail/getTempName` provided.
- **CHECK constraint incompatible with BA's multi-step create** — dropped the email-or-phone CHECK (PG CHECKs can't be DEFERRABLE), moved invariant to app layer; made `display_name`/`username` nullable.
- **`generateId`** special-cased `user`/`users` → false so PG generates the uuid.
- **Raw BA OTP HTTP endpoints bypassed throttling** — 16 BA OTP paths deny-listed (403) at the Fastify layer; all OTP funnels through the hardened `/auth/start|verify` façade driving BA via in-process `auth.api.*`.
- **OTP test flakiness** — per-IP OTP cap made env-configurable for CI.

### Upload (the four-failure subsystem) — `apps/mobile/src/lib/upload/`
1. **Missing native module in Expo Go.** `react-native-background-upload` (`RNFileUploader`/`VydiaRNFileUploader`) is absent in Expo Go → `Upload.startUpload` derefs undefined. Fix: presence check → transparent foreground fallback + one-time dev warn.
2. **ArrayBuffer/heap OOM on large videos.** The first fallback did `fetch(uri).blob()` + XHR — loaded the whole file into the JS heap, fatal for large videos. Fix: streaming, disk-backed `expo-file-system` `createUploadTask` (heap stays flat).
3. **SDK 56 API moved.** `uploadAsync`/`createUploadTask` no longer on root `expo-file-system` — they live on the **`expo-file-system/legacy`** subpath.
4. **Content-type 415** on the presigned PUT — see API section.
- **Cancel-during-blob-materialization bug.** `xhr.abort()` is a no-op while UNSENT (during `await fetch(uri).blob()`), so a cancel in that window was silently lost and `send()` fired anyway. Fix: `aborted` flag + `AbortSignal` wired up-front + bail before `send()`.
- **`file://` scheme asymmetry** (easy to get wrong): background-upload wants a **bare path** (strip `file://`); the legacy fileSystem path wants the **full `file://` URI** (don't strip).

Architecture: a `PutFile` contract (`{done, cancel}` handle, 0..1 progress) with a Metro platform split — `transfer.web.ts` / `transfer.native.ts`, native delegating to background-upload or the Expo-Go-safe `transfer.fileSystem.native.ts`; web + Expo-Go fallback share `transfer.foreground.ts` (XHR, because `fetch` can't report request-body progress). The base `transfer.ts` throws "no platform implementation resolved" as a misconfiguration tripwire. **This is the proven shape — reuse it.**

### API / content-type
- **Blanket 415 on body-bearing requests.** Fastify's default parser only handles `application/json` + `text/plain`; RN/Expo fetch sometimes sends a body with missing/`application/octet-stream` Content-Type → 415 before the route runs. Fix: root `'*'` parser (parse-as-string, try `JSON.parse`, else raw) so requests reach the route and get a clean 401/422. Better Auth's own encapsulated `'*'` parser is unaffected. Covered by `test/contentType.test.ts`.
- **CORS preflight blocked browser writes.** `@fastify/cors` v11 defaults methods to GET/HEAD/POST → every PATCH/PUT/DELETE preflight rejected. Fix: explicit method list. **Slipped through because inject-based tests never issue a real preflight** — a genuine coverage blind spot.
- **Presigned PUTs can't gate size/type up front.** Worked around with a post-upload `HeadObject` gate at `/media/:id/complete` (reject over-cap/type-mismatch) + **ETag-pin** to close a TOCTOU where a client re-PUTs a swapped object to the same key.

### Mobile / Expo
- **Stale version guesses** — always `npx expo install --fix`. SDK 56 reality: expo ~56.0.12, RN 0.85.3, React 19.2, TS 6.0.3 (PLAN.md's RN 0.81 was wrong).
- **Reanimated 4.x requires `react-native-worklets`** + the babel plugin `'react-native-worklets/plugin'` (not `reanimated/plugin`).
- **Mobile runs its own TS 6** while the spine/api use root TS — pnpm isolation makes it fine.

### Render (headless Remotion)
- **CRITICAL perf gotcha: `chromiumOptions.gl` MUST be `null`, not `'angle'`** (~9× slower otherwise — serializes rasterization through one GPU process). With `gl:null` + concurrency + x264 veryfast + crf23 + shared browser, renders are ~20–70s (budget p95<120s). All knobs env-overridable.
- **Chrome blocks `file://` media** → serve media over HTTP (`startMediaServer` + out-of-band `srcMap`).
- **Import scoring/EDL builders directly, not the barrel** — the `intelligence` barrel pulls untyped essentia.js, breaking API tsc when it imports `@twenty4/worker`.
- **drizzle-kit must include `enums.ts` in `schema`** or pgEnums aren't emitted as `CREATE TYPE`; first migration hand-prepends `CREATE EXTENSION citext/pgcrypto`.

### Deletion / the 24h promise (hardest correctness target)
- **The deletion gate failed on first attempt** (slice 7 functional was explicitly "GATE NOT YET PASSED"). Adversarial review found: replace hid the prior montage from the sweep; no raw-purge backstop; orphan draft rows never swept; NULL-expiry montages never swept; non-atomic tombstone. Fixed with reclaim sweeps + a DB CHECK constraint + atomic tombstones + 6 lost-job regression tests.
- **A third hole surfaced in slice 8** — reported-content PII snapshots were retained indefinitely past their +7d purge date; fixed with a `snapshotPurgeSweep` job.

### Testing
- **BullMQ custom jobId CANNOT contain `':'`** — use `'-'` (silently breaks delayed-job scheduling, which *is* the 24h-expiry mechanism).
- Tests run against the **live** stack (no infra mocks); `globalSetup` flushes only OTP/rate-limit Redis keys for rerun determinism.
- **Idempotency lib must release the claim on op-throw** — subtle retry-safety requirement.

---

## 6. Workarounds & stubs still in the code

**Active fallbacks / accepted-limit code (keep, by design):**
- `transfer.native.ts` — Expo-Go module-absent → foreground fallback.
- `transfer.fileSystem.native.ts` — `expo-file-system/legacy` subpath; keep-full-URI caveat.
- `transfer.foreground.ts` — abort-before-send guard.
- `app.ts` — `'*'` content-type parser + explicit CORS methods.

**Prod-deferred stubs (must be wired before any real launch):**
- `auth/otpTransport.ts` — OTP transport is a **throwing stub**; needs SES/Resend (email) + SMS.
- `auth/betterAuth.ts`, `modules/auth/index.ts` — Apple/Google social = stub.
- `worker/lib/analytics.ts` — analytics vendor forwarding = stub.
- `worker/intelligence/scoring/score.ts` — heuristic "face presence" → real tiny face detector.
- `worker/jobs/validateMedia.ts` — freshness "not PROVEN" flag; needs P2 capture attestation.
- `infra/remotion/.../music` — 4 synthesized placeholder tracks → licensed/CC0 + real beat grids.
- `apps/mobile/.../contacts.tsx` — contacts permission is stubbed.
- Various `TODO(spec-gap)` in contracts where the spec is silent (report reasons, audit actions, username hashing).

**Dead code to delete in a rebuild:** empty `safetyModule` (unregistered), `emitMediaAdded` (never called → `media_added` analytics event never fires — a §12 gap), `objectExists`/`objectSize`/`activeGroupIds` (superseded), duplicated `deviceTimezone()` across 3 mobile files.

---

## 7. Setup / run pain (to fix in the rebuild)

- **Two conflicting infra stories.** `docker-compose.dev.yml` (checked in, **not used**, :5432) vs `scripts/dev.sh` (the real no-Docker path, :5433). A cold reader could wrongly `docker compose up` and hit the port divergence. **Reconcile to one story with a loud README pointer.**
- **`source ~/.twenty4-dev-env.sh` is a mandatory hidden global dependency** (selects Node 22, exports `DATABASE_URL`/`REDIS_URL`/`S3_*`/`FFMPEG_PATH`/`PG_BIN`/`PGDATA`) that lives **outside the repo** — a reproducibility gap. Bake the env bootstrap into the repo.
- **Device run is a 4-part checklist, not a step:** dev-client build (Expo Go won't run custom native modules) + `0.0.0.0` bind + LAN IP env var + WSL2 mirrored networking. All four must be right simultaneously. (`RUNNING.md` documents this well — keep that.)
- **Browser is the easy path** — `pnpm web` runs the whole loop against local API; native-only screens are stubbed on web; dev OTP retrievable at `/auth/dev/last-otp?identifier=`.
- **`temp/`** is a throwaway: ~90 Playwright screenshots + a static gallery to visually diff the built app against `reference/Spool.html` (the only practical QA on an emulator-less box). Not product code.

---

## 8. Key learnings for the rebuild

1. **Pin one physical copy of drizzle-orm before adding auth.** The better-auth→kysely dual-copy clash burned real time. Add the dedupe lever (`kysely` devDep on the schema package + `.npmrc dedupe-peer-dependents=false`) up front.
2. **Never trust version guesses for Expo** — `npx expo install --fix` is the source of truth (PLAN.md itself was wrong about RN). Reanimated 4 ⇒ `react-native-worklets` + its babel plugin.
3. **Design the upload subsystem with the platform-split + streaming fallback from day one.** Four independent failure modes (Expo-Go missing module, heap-OOM blob, SDK-56 legacy API move, content-type 415), most device-only. The `{done,cancel}`/0..1 contract + Metro `.web/.native` split + disk-backed streaming fallback is proven. Mind the `file://` strip asymmetry and abort-before-send.
4. **Presigned PUTs can't gate size/type — enforce after** with `HeadObject` + ETag-pin at `/complete` (closes both the size/type-lie and the TOCTOU swapped-object hole).
5. **Front-door HTTP hardening for RN clients is two one-time fixes:** the `'*'` content-type fallback parser and an explicit CORS method list. Otherwise they look like mysterious 415 / preflight failures. Add a test that issues a **real preflight** (inject tests miss it).
6. **Headless Remotion: `gl:null` is non-negotiable** (~9× speedup); serve media over HTTP (Chrome blocks `file://`); keep render as an explicit early gate; keep the swappable `Renderer` interface (it's what makes the stub→Remotion→Lambda path clean).
7. **The 24h deletion promise is the hardest thing to get right.** Make it a first-class milestone with defense-in-depth: authoritative app jobs + repeatable reclaim sweeps for lost jobs + DB CHECK + atomic content-free tombstones + lost-job regression tests. Budget for the gate to fail once.
8. **Reconcile the infra story in one place** and bake the env bootstrap into the repo. Document the device-networking checklist as a unit.
9. **Drizzle migration gotchas:** include `enums.ts` in `schema`; hand-prepend `CREATE EXTENSION citext/pgcrypto`; PG CHECKs can't be DEFERRABLE (multi-step creators force invariants to the app layer).
10. **BullMQ jobIds can't contain `':'`** — use `'-'`.
11. **The implement → adversarial-verify → fix → re-verify loop paid off every slice** — it's where the upload abort-bug, the TOCTOU pin, the OTP-throttle bypass, and the deletion backstops were all found. Budget for it.
12. **Track accepted limitations explicitly** so the rebuild carries them as Phase-2 line items instead of rediscovering them: forgeable media freshness (no capture attestation), plaintext phone OTP (BA 1.6), placeholder music, stubbed social auth + OTP transport, deploy-time CORS/trustProxy hardening.

---

## 9. What to keep vs. change in the rebuild

**Keep (these were right):**
- The **contracts-as-spine** pattern (schema + DTOs + EDL + enums + errors in one package).
- The **swappable `Renderer` / decoupled `Intelligence`** design.
- The **4am day-window** logic (DST-correct via `Intl`, persisted on the row).
- The **platform-split upload contract** and the streaming fallback.
- The **defense-in-depth deletion** model and the **analytics firewall** (allow-listed dimensions, never stores user id/content).
- The **`functional → adversarial-verify → hardening`** slice rhythm.
- `RUNNING.md`'s device-networking checklist.

**Change (per `REBUILD_PLAN.md`):**
- **pnpm → Bun** (caveat: Metro & Remotion still need Node under the hood).
- **Expo Go first, Android-first** — accept foreground/streaming uploads for MVP; defer background upload + dev-client to a dedicated later milestone instead of discovering the gap on-device.
- **Reconcile infra to one no-Docker story**; bake env bootstrap into the repo.
- **Isolate & device-verify upload (and the render pipeline) early**, before features depend on them.
- **Delete the dead code** listed in §6 from the start.
- **Decide the open items** up front: TS/WASM beat detection (no Python), music licensing, `processing_status`/`validation_status` reconciliation, feed-window-vs-calendar-day.
```
