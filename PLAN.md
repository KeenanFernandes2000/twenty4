# twenty4 — Phase‑1 Internal Alpha: Build Plan

## Context

**twenty4** is a mobile app for private friend groups: each user collects *today's* photos/videos, the app server‑side auto‑generates a **30‑second 9:16 beat‑synced montage**, the user reviews and publishes it to selected groups, friends react/comment, and **all server content is hard‑deleted after 24h**. (Think BeReal's daily habit + Threads' casual feed + auto‑editing, "temporary by default.")

This plan is grounded in three references the user supplied (`reference/twenty4_Development_Spec.md` — the authoritative engineering spec; `reference/mobile app PRD.md` — product rationale; `reference/Spool.html` — the "Ember" design prototype, ~35 screens in light+dark). Those files were originally **gitignored** (`/reference`) and missing from this fresh cloud clone; the user re‑committed and pushed them, and I fetched `reference/` from `https://github.com/KeenanFernandes2000/twenty4.git`.

**The repo is greenfield** (only `.gitignore`). The user's decision for this build: deliver the **complete Phase‑1 "Internal Alpha"** (spec §14) — the entire core loop end‑to‑end — plus a documented Phase 2/3 roadmap, with the mobile client on **Expo + dev client**. This is a multi‑session effort; the plan is sliced so each step is independently demoable and we commit per slice.

> **Naming:** the prototype is branded "Spool" — the app is **twenty4** everywhere (name, scheme `twenty4://`, copy, assets).

### Decisions locked

| Area | Decision | Source |
|---|---|---|
| Scope (this build) | Full Phase‑1 Internal Alpha, end‑to‑end + P2/P3 roadmap | user |
| Mobile | **Expo SDK 56** + **dev client** (New Arch RN 0.81), TS; `expo prebuild`→bare path stays open | user |
| Backend | **Node 22 + TypeScript + Fastify 5** | spec §3 (Node/TS recommended) |
| Auth | **Better Auth 1.6** (email/phone OTP + Apple + Google; sessions in Postgres) | spec §2 |
| DB / ORM | **PostgreSQL 16 + Drizzle 0.45** (partial/composite indexes, `citext`, checked‑in SQL, no engine binary) | spec §5 |
| Storage | **S3‑compatible** (MinIO local / R2|S3 prod), signed URLs only, no public read | spec §3/§11 |
| Queue | **BullMQ + Redis 7** | spec §3 |
| Beat detection | **essentia.js** (WASM, headless‑safe); `node-aubio` fallback. Bundled tracks → beat grids precomputed/cached | spec §7.1 [TEAM] |
| Renderer | **Remotion 4.0** (`@remotion/renderer` `renderMedia`) on a single self‑hosted worker, behind a swappable `Renderer` interface; Lambda deferred | spec §2/§7.2 |
| Monorepo | **pnpm workspaces + Turborepo 2** | [TEAM] |

All libraries verified present on npm at current versions (Expo 56.0.12, @remotion/renderer 4.0.481, better-auth 1.6.19, drizzle-orm 0.45.2, fastify 5.8.5, @tanstack/react-query 5.101, expo-camera/-media-library/-video 56.x, react-native-background-upload 6.6, zustand 5, turbo 2.9).

### Findings that shape the build
- **The prototype is *ahead* of the spec on "missing" screens.** `Spool.html` already contains `2.2 Camera (dark)`, `2.4 Generating (dark)`, and `5.6 Delete account` — which spec §9 lists as missing. Only **3** are genuinely undesigned: per‑item **upload‑in‑progress**, **render‑failure+retry**, **replace/republish confirm**. We build these functionally now (Ember primitives) and flag for design.
- **`Spool.html` is a 549 KB minified CSS‑in‑JS bundle** — a *visual reference*, not importable code. We re‑implement the Ember system natively in RN from the extracted tokens.
- **Ember tokens (confirmed, light/dark):** accent `#ec5430`/`#ff7a52`, on‑accent `#fff`; light `bg #fbf6f1 / canvas #e8dccd / surface #fff / text #241712 / field #f3ebe3 / muted #8a7a6d / danger #e23b3b / success #1fa572`; dark `bg #161210 / canvas #0a0a0c / surface #221c18 / text #f7f0e9 / field #2c241f / muted #a3958a / danger #ff6a6a / success #36c98a`; plus `border, scrim, label, faint, hdsub, bezel, vid, vidBand`. Type: **Nunito** (UI) + **JetBrains Mono** (mono). Themes Chill/Party/Clean/Travel/Fast Cut/Soft/Mellow(+Random). Reactions like/laugh/fire/heart/shocked.
- **Environment:** headless Linux (no iOS/Android emulator). User previews on phone (Expo dev build); I verify here via typecheck/tests (dockerized PG+Redis+MinIO), a real Remotion MP4 render smoke test, and **Expo‑web + Playwright screenshots** of the design system + non‑native screens.

---

## Repo & git setup (do first)
Local `HEAD` is the seed commit (only `.gitignore`); the user's `origin/main` has *diverged* — it now also contains the `reference/` commit. Before implementing: add the remote, fetch, and **rebase local onto `origin/main`** so the reference commit is preserved and we branch cleanly. Work on a feature branch (e.g. `phase-1-foundation`), commit per slice, push with `-u origin <branch>` (retry w/ backoff on network errors). Keep `/reference` gitignored (it's already tracked upstream; don't duplicate).

## 1. Monorepo layout
pnpm workspaces + Turborepo; Node 22 runtime. `packages/contracts` is the **single source of truth** imported by app + api + worker.

```
twenty4/
├─ package.json · pnpm-workspace.yaml · turbo.json · tsconfig.base.json · .nvmrc(22) · .env.example
├─ docker-compose.dev.yml          # postgres:16, redis:7, minio + bucket-init (local infra + tests)
├─ packages/
│  ├─ contracts/   ⭐ src/{db/(Drizzle tables+inferred types §5), dto/(Zod per §8 body), edl.ts(§7.1), enums.ts, analytics.ts(§12), errors.ts}
│  ├─ api-client/  # typed fetch client, one method per §8 endpoint → contracts DTOs
│  └─ config/      # shared eslint/tsconfig/prettier presets
├─ services/{api, worker}/
├─ apps/{mobile (Expo), admin (minimal Vite+React moderation/ops)}/
└─ infra/{remotion (compositions), docker (Dockerfile.worker w/ chromium deps, Dockerfile.api), migrations (drizzle-kit SQL, checked in)}/
```

**Why contracts is the spine:** the EDL the intelligence layer emits is *exactly* the shape the Remotion composition reads; the DTOs the client sends match what the API validates (Zod `z.infer` = compile‑time type + runtime validator, no drift).

## 2. Mobile app (`apps/mobile`, Expo SDK 56 + dev client)

**expo-router** file‑based routes mapped 1:1 to the ~35 prototype screens; root **auth stack vs. 4‑tab main** gated on `authStore.session`.
```
src/app/_layout.tsx                # ThemeProvider + QueryClientProvider + font gate + auth redirect
 (auth)/  welcome 1.1 · sign-in 1.2 · verify 1.3 · profile-setup 1.4 · contacts 1.5 · notifications-priming 1.6 · legal 1.7
 (main)/_layout.tsx                # Tabs: Today | Feed | Groups | Profile
   today/    index 2.1 · camera 2.2(dark,native) · gallery 2.3 · generating 2.4(dark,poll) · review 2.5 ·
             theme 2.6 · music 2.7 · publish 2.8 · published 2.9 · ⚠upload-progress · ⚠render-failed · ⚠replace-confirm
   feed/     index 3.1 · player 3.2(dark,modal) · comments 3.3 · report 6.1 / block 6.2
   groups/   index 4.1 · [id] 4.2 · create 4.3 · invite 4.4 · join 4.5 (deep-link twenty4://invite/[code]) · members 4.6
   profile/  index 5.1 · edit 5.2 · settings 5.3 · notifications 5.4 · blocked 5.5 · delete-account 5.6
 states/                           # 7.x offline/skeleton/empty/error/suspended/toasts = global shared components, not routes
```

- **Theming** `theme/tokens.ts` = two frozen typed objects (light/dark) keyed to the Ember vars; `ThemeProvider` (system|light|dark, persisted in secure-store) exposes `useTheme()` — **no hardcoded colors**. Camera/generating/player/reactions wrap a **forced‑dark** provider (prototype behavior). Fonts via `expo-font` (Nunito, JetBrains Mono), gate first render on `useFonts`.
- **UI library** `ui/` reproduces Ember primitives: `Button, Field, Card, Sheet, Chip, Avatar, Skeleton, Toast, CountdownBadge, SegmentedControl, ListRow, EmptyState, ErrorRetry, ProgressBar` + icons.
- **Data layer** **React Query v5**: `useFeed` (infinite, 10/page §10), `useTodayMedia`, `useMontage(id)` (`refetchInterval` while `generating` → drives 2.4 + render poll §7.3), `useGroups`, `useComments`, reaction mutations (optimistic + rollback). API via `@twenty4/api-client` wrapped to inject session token + handle 401→logout / `suspended`→7.5. **zustand** `authStore` (token in `expo-secure-store`) + `uploadStore` (in‑flight progress/retry).
- **Native modules (config plugins → dev client):** `expo-camera` (2.2), `expo-image-picker`+`expo-media-library` (2.3 pick + EXIF/asset metadata for §6 validation; save‑to‑gallery for owner download §11.10), `expo-video` (autoplay‑muted previews + tap‑to‑sound), `expo-notifications` (Phase‑1 local capture/expiry reminders), **`react-native-background-upload`** (true background/resumable — *not* `expo-file-system` background sessions, known large‑file failures; foreground `uploadAsync` fallback on web), `expo-secure-store`, `expo-linking` (invite deep links).
- **Web‑renderable (for my screenshots) vs native‑only (user verifies on device):** renderable — all auth, today bucket, review layout (placeholder video), theme/music, publish/success, feed layout + comments + report/block, all groups, all profile/settings, all 7.x states. Native‑only — 2.2 camera, 2.3 real metadata, real video autoplay/3.2 player, push, background upload, save‑to‑gallery.

## 3. Backend API (`services/api`, Fastify 5)
Module‑per‑§8‑resource layout; Better Auth handler; Drizzle; BullMQ producer (enqueue only).
```
src/ server.ts · env.ts(zod) · db/ · auth/{betterAuth.ts, middleware.ts(requireSession, reject suspended/banned)} ·
 authz/{groupMembership.ts(assertMemberOf), blocks.ts(both-direction filter)} ·
 modules/{users, groups, media, montage, feed, social, safety, admin}/  # each = routes+service+repo per §8
 storage/s3.ts(presign PUT/GET, TTL=min(default, remaining lifetime), bucket map raw|montages|thumbnails) ·
 queue/producers.ts · lib/{dayWindow.ts, idempotency.ts, rateLimit.ts, errors.ts} · analytics/emit.ts
```
- **Better Auth:** email/phone OTP + Apple + Google (**Apple mandatory** since other socials ship, App Store rule); sessions in PG (immediate revocation for suspend/ban/delete). `/auth/start|verify|refresh|logout` map to Better Auth ops; `DELETE /users/me` revokes sessions then enqueues purge.
- **Schema/migrations (§5)** in `@twenty4/contracts/db`: all entities incl. `montage` **partial index `(status,expiry_at) WHERE status='published'`**, `daily_media_item (user_id,day_bucket,validation_status)`, `montage_group_visibility` (one render→many groups + authz), uniques on reaction/block, `audit_log`, `idempotency_key` + Better Auth tables. `drizzle-kit generate` → checked‑in SQL.
- **Authz on every media/feed request** (preHandler): `requireSession` → `assertMemberOf` → block‑filter; feed joins `montage_group_visibility` to caller's active memberships minus blocked (both directions); `download-url` **owner‑only** (Q7); expired/deleted → **404**.
- **Idempotency** keys on `publish`/`replace`; **rate limits** on upload/comment/reaction/invite‑join; invite links enforce expiry + use‑cap (Q11).

## 4. Montage pipeline (`services/worker` + `infra/remotion`)
Split **intelligence (→EDL)** and **renderer (EDL→MP4)** behind `Renderer.render(EDL) → {videoPath, thumbnailPath, durationMs, status}` (§7.2).
```
worker/src/ index.ts(BullMQ Workers; render concurrency=1) ·
 jobs/{validateMedia, renderMontage, cleanupRaw, expireMontage, dispatchNotification} ·
 intelligence/{beat/analyze.ts, scoring/score.ts, edl/build.ts, themes.ts} ·
 render/{Renderer.ts(interface), RemotionRenderer.ts, index.ts(factory; Lambda swap later)} ·
 media/(ffprobe/ffmpeg helpers) · validation/harness.ts(§7.5)
infra/remotion/src/ Root.tsx · Montage.tsx(1080×1920, 30s, 30fps; reads EDL props) · components/(segment/transition/overlay) · music/(~15 bundled tracks + music_id→file)
```
- **Intelligence (§7.1, algorithmic, no ML):** beat grid via essentia.js (`RhythmExtractor2013`; precomputed per bundled track) → clip scoring (motion frame‑diff, sharpness variance‑of‑Laplacian blur‑reject, face presence, brightness; photos flat) → **beat‑synced 30s allocation** (cut on beat, faster in high‑energy sections, trim videos to top‑scoring beat‑aligned window, hold photos a beat) → theme styling → **emit EDL** (`@twenty4/contracts/edl`). Renderer makes no creative decisions.
- **Renderer (§7.3):** bundle remotion project once (`@remotion/bundler`), `selectComposition` `<Montage/>`, `renderMedia({codec:'h264', inputProps: EDL})` → MP4 + thumbnail → upload → `status=draft_ready`.
- **Headless Linux:** `Dockerfile.worker` installs Chrome‑Headless‑Shell apt deps (`libnss3 libgbm-dev libasound2t64 libxkbcommon-dev libxcomposite1 libxdamage1 libcups2 libpango-1.0-0 libatk-bridge2.0-0` …) + ffmpeg + `npx remotion browser ensure` (let Remotion manage the binary).
- **§7.4 failure:** `attempts:2` (retry once) → 2nd failure surfaces `render-failed.tsx`; 5‑min hard timeout; cleanup partial S3 on failure (no orphans).
- **§7.5 gate:** `validation/harness.ts` on 50 mixed items + a track asserts 9:16 / 30.0s / beat‑aligned / within §10 time — **must pass before wiring the app flow.**

## 5. Data lifecycle & deletion (the core promise, §6)
- **4am→4am `day_bucket` (Q3):** server‑authoritative `lib/dayWindow.ts` (+ client mirror); `floor((utc−4h) in device tz)`; **persist on the row, never recompute at read.** Vector: 01:30 local on the 12th → bucket = 11th.
- **Validation (Q4):** EXIF `DateTimeOriginal` → media‑library creation → file creation → else `invalid`; must fall in today's window; anti‑tamper device‑vs‑server delta flag; in‑app captures auto‑valid.
- **Raw purge (Q5):** publish → schedule `cleanup-raw` at **+60 min** → hard‑delete *all* raw (used+unused) + draft renders (rows+S3); day‑close sweep purges unpublished; account delete purges immediately.
- **24h expiry:** set `published_at`, `expiry_at=+24h`; **delayed `expire-montage` job + repeatable `sweep-expiries`** (idempotent, belt‑and‑suspenders via partial index) → delete video+thumb (S3) + row, **cascade reactions+comments**, write `audit_log` tombstone (no content). Only anonymized aggregate counts persist in analytics (Q6).
- **Replace (Q2):** new render; on its publish hard‑delete prior montage + its reactions/comments; idempotency‑guarded.
- **Defense in depth:** S3 lifecycle (raw short TTL, montages ~25h) is **backstop only**; app jobs are authoritative; signed‑URL TTL ≤ remaining lifetime so leaked URLs 404 with content.

## 6. Execution order (vertical slices, demoable each; commit per slice)
- **0 — Skeleton & infra:** monorepo+Turbo, `contracts`, docker‑compose (PG/Redis/MinIO), migrations, Fastify health, Expo boot + ThemeProvider + Ember tokens/fonts + **design‑system gallery screen**. *Demo: CI green; web screenshot of component gallery light+dark.*
- **1 — DE‑RISK RENDER (§7.5 gate):** remotion `<Montage/>` + `RemotionRenderer` + intelligence + `Dockerfile.worker`; run harness. *Demo: real 9:16/30s beat‑synced MP4 headless in CI within §10. **Gate.***
- **2 — DE‑RISK NATIVE CAPTURE+UPLOAD:** dev client + camera (2.2) + gallery/metadata (2.3) + background upload + signed‑URL flow + `POST /media`. *Demo (phone): capture/pick→upload‑with‑progress→row.*
- **3 — Auth/onboarding:** Better Auth (email OTP→Apple/Google), `(auth)` 1.1–1.7, authStore+secure‑store, `requireSession`. *Demo: real sign‑up→tabs.*
- **4 — Groups + invite/join:** CRUD, invites (expiry+use‑cap), members, leave, deep‑link join. *Demo: A invites, B joins, authz enforced.*
- **5 — Generate→review→publish (wires Slice 1 to app):** `POST /montages`→poll→2.4 generating, 2.5 review (+theme/music/regenerate), 2.8 multi‑group publish (idempotent), 2.9 success, render‑failed. *Demo: full create loop on device.*
- **6 — Feed + social:** `GET /feed` (cursor, member groups, block‑filtered), 3.1 autoplay‑muted + countdown, 3.2 player, reactions/comments, owner delete + owner download. *Demo: A publishes, B views/reacts/comments.*
- **7 — Deletion lifecycle + replace:** cleanup‑raw, expire+sweeps, cascades, tombstones, `/replace` + confirm, URL‑404. **Full §6 test suite.** *Demo: raw gone after grace; montage+social gone at 24h; old URL 404; CI green.*
- **8 — Safety + minimal admin + account deletion:** reports/blocks (6.1/6.2), Suspended gate (7.5), `DELETE /users/me` purge (5.6), `apps/admin` (search/suspend/ban, review reports, remove content, failed jobs/storage/metrics). *Demo: report→admin remove→audit logged.*
- **9 — Polish + global states + analytics:** 7.x states, §12 events (no content), local reminders. *Demo: complete alpha; §6/§10 acceptance pass.*

**Critical path:** 0 → 1(gate) → 5 → 6 → 7. Slices 2/3/4 parallelize once Slice 0 contracts land.

## 7. Verification
**Here (headless):** `turbo run typecheck lint`; **Vitest integration** vs dockerized PG16+Redis7+MinIO — API authz/membership/block‑filter/idempotency/rate‑limit, day‑window vectors, validation hierarchy, and the **full §6 deletion suite** (raw‑after‑grace, expiry cascade, signed‑URL‑404, audit logging, account‑purge SLA); **Remotion render smoke test (actual MP4)** + §7.5 harness; **Expo web export + Playwright screenshots** of design system + every non‑native screen on seeded mocks. **Acceptance mapping:** §6→deletion suite, §10 render timing→harness, §10 feed/authz→API tests, §11 (no public URLs / expired 404)→storage/authz tests.
**On device (user):** camera, real gallery metadata, video autoplay+sound, background upload, push, save‑to‑gallery, deep‑link invite, cold‑start <2.5s / feed p95 <1.5s (§10 device‑bound).

## 8. Top risks → mitigation
1. **Headless Remotion perf (HIGH)** → Slice‑1 gate w/ exact apt deps + `remotion browser ensure`; precomputed beat grids; measure vs §10 before app flow; Lambda behind interface.
2. **Native background/resumable upload (HIGH)** → dev client + `react-native-background-upload` (not expo-file-system background); web foreground fallback; per‑item retry UI; `prebuild` escape hatch.
3. **Deletion correctness — the promise (HIGH)** → app jobs authoritative (S3 lifecycle backstop); delayed job + idempotent sweep; full §6 suite is an exit gate; audit tombstones.
4. **Beat detection headless (MED)** → essentia.js WASM primary, cached on bundled tracks; `node-aubio` fallback (essentia.js is 0.1.x — validate early in Slice 1).
5. **Day‑window/TZ edges (MED)** → persist resolved bucket; shared resolver; spec vectors + DST cases; anti‑tamper deltas.
6. **3 undesigned screens (LOW‑MED)** → functional Ember versions now, flag for design.
7. **§13 business unknowns (music source, Remotion Company License if team>3, report‑retention, legal docs)** → build on stated assumptions (~15 bundled tracks; 7‑day reported‑content retention; budget license; `/legal/*` reader stub). Not eng‑blocking.

## 9. Roadmap (spec §14)
- **Phase 2 — Closed Beta:** onboarding polish; feed UX (prefetch, watch‑time analytics); expand themes/music once licensing decided; **push end‑to‑end** (APNs/FCM dispatcher: friend posted/reacted/commented/expiring/invite, per‑group mute + reminder‑time 5.4); render reliability hardening (backoff, DLQ, monitoring); mature report/block; basic admin analytics dashboard. (Hooks already present: `dispatch-notification` queue, analytics schema, admin shell.)
- **Phase 3 — Public Launch:** store‑ready privacy/ToS + data‑safety; matured UGC moderation (report snapshot retention §13); account deletion to SLA; production monitoring/alerting (cleanup success, render failure <5%, storage, expired counts via §12 ops events); **scalable rendering** — swap `RemotionRenderer`→Lambda (`renderMediaOnLambda`) behind the unchanged interface, validated at concurrency; App/Play submission (Apple Sign‑In already shipped).

## Critical files
- `reference/twenty4_Development_Spec.md` — authoritative (§5 schema, §6 lifecycle, §7 EDL/render, §8 API, §10 NFRs)
- `packages/contracts/src/edl.ts` — EDL contract (intelligence↔renderer seam)
- `packages/contracts/src/db/` — Drizzle schema + inferred types (§5; single source of truth)
- `services/worker/src/render/Renderer.ts` — swappable renderer (Remotion now, Lambda later)
- `services/api/src/lib/dayWindow.ts` — 4am day‑window resolver (core of the deletion promise)
- `apps/mobile/src/app/_layout.tsx` — root nav + ThemeProvider + auth gate (client entry)
- `infra/docker/Dockerfile.worker` — headless Remotion (chromium deps + `remotion browser ensure`)

> **Note:** Phase‑1 is large (9 slices, full‑stack). On approval I start at **Slice 0** and proceed incrementally, committing per slice and checkpointing with you. The render gate (Slice 1) and deletion suite (Slice 7) are the hard correctness gates.