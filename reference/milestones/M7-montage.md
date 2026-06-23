# M7 — Montage pipeline (Remotion from the start)
> Spec phase: P1 · Depends on: M0 (infra + Redis + MinIO + `fixtures/sample-media/`), M1 (error envelope, content-type, CORS), M2 (sessions/guards), M3 (groups + membership authz), M4 (storage presign + `daily_media_item` + day-bucket), M6 (capture/import → media in today's bucket) · Branch commit: one squashed commit on `rebuild/v2` ("M7: montage pipeline — BullMQ render + Remotion + intelligence + review/publish")

> **Departure from REBUILD_PLAN §4 M7 (no stub):** the rebuild plan originally split M7 (stub ffmpeg renderer) from M10 (Remotion + beat-sync). **Per the founder's locked call, this milestone collapses both: a REAL Remotion render pipeline + the algorithmic intelligence layer are built from the start, behind the swappable `Renderer` interface (Lambda noted as a later drop-in).** There is no ffmpeg-concat stub stage. The §7.5 render gate must produce a real beat-aligned 1080×1920/30fps/~30s h264 mp4 from `fixtures/sample-media/`.

## 1. Goal
On-device: a user with media in today's bucket taps generate → the server enqueues a render, the app shows a **generating/progress screen**, and within the §10 budget a **real 1080×1920 / 30fps / 30s h264 montage** (beat-aligned to a bundled track, themed) appears on the **review screen**; the user can regenerate, remove media + regenerate, then **publish to one or more groups** — and **watch the produced mp4 play back on the Android device in Expo Go.** The render is genuine Remotion (no stub), behind a swappable `Renderer` so Remotion Lambda is a later drop-in with zero API/job-contract change.

## 2. Scope
- **In scope:**
  - **`services/worker` (extend):** BullMQ + Redis worker process (Node, not Bun — Remotion is Node-based). Queues: `render-montage` (+ the failure/cleanup side of render here; deletion/expire queues are **M9**).
  - **Swappable `Renderer` interface** (`render(edl) → { videoPath, thumbnailPath, durationMs, status }`) with a single concrete **`RemotionRenderer`** behind it. Remotion **Lambda** documented as a future drop-in (`renderMediaOnLambda`) behind the *same* interface — not built here.
  - **Algorithmic Intelligence layer (TS/WASM, NO Python):**
    - **Beat detection** via `essentia.js` (WASM, DSP — no ML). Used to *precompute* beat grids for bundled tracks (see music below); at request time the EDL builder reads the **precomputed** grid (no per-request beat analysis on user audio — there is no user audio in MVP, Q8).
    - **Per-clip scoring heuristics:** motion/activity, sharpness (blur reject), brightness, loose-face presence (cheap heuristic, not a model — flagged for later upgrade). Photos get a flat score. (`sharp` + `exifr` + frame sampling.)
    - **Beat-aligned EDL builder:** allocate the 30s timeline across selected media, cutting **on the beat**; trim each video to a beat-aligned window around its highest-scoring moment; hold photos for a beat-length window; default chronological ordering; the beat grid (not fixed 1–3s rules) drives durations.
    - **Per-theme pacing:** theme (Chill, Party, Clean, Travel, Random, Fast Cut, Soft) sets transition style, cut-density bias, overlay treatment.
  - **Strict Zod EDL schema in `packages/contracts`** (`.strict()`): `width:1080`, `height:1920`, `fps:30`, `durationMs:30000` (all **literals**), `segments[]`, `beatGrid`, `themeStyle`, `audio`. Single source of truth, consumed by API + worker + the Remotion composition.
  - **`infra/remotion` `<Montage/>` composition** consuming the EDL (1080×1920, 30fps, 900 frames), reading `segments`/`audio`/`themeStyle` as props; emits the mp4 + a thumbnail.
  - **Bundled music tracks with PRECOMPUTED beat grids** in `infra/remotion/.../music` (placeholder synth / CC0 for now — licensing is an open §13 flag). Beat grids precomputed offline via the essentia.js path and checked in next to each track.
  - **API montage routes** (auth-gated, group-authorized): `POST /montages` (generating → enqueue → **202**), `GET /montages/:id` (client polls), `POST /montages/:id/regenerate`, `GET /montages/options`, `POST /montages/:id/publish` (multiple groups). (`replace`, `download-url`, `DELETE` montage → **M9/M8**: replace lives with the deletion contract, download/delete with social — see scope-out.)
  - **Status machine:** `not_generated → generating → draft_ready → published`, with side-branches `→ failed`, (`→ deleted_by_user / removed_by_admin / expired` reserved for M8/M9).
  - **Render reliability:** failure → **auto-retry ONCE** → user-facing **retryable** error; **5-min hard timeout**; **NO orphaned S3 objects** on failure (cleanup); **guard against concurrent regenerate** (idempotency / single in-flight render per montage).
  - **`montage` + `montage_group_visibility` tables** (montage carries `edl` jsonb, `source_media_ids`, `theme`, `music_id`, status, paths, day_bucket). **One recap per user/group/day.**
  - **Mobile (Expo Go):** the two **§9 missing-design** screens — **generating/progress** and **review** (preview, expiry info, group selection, regenerate, remove-media-and-regenerate) — built here.
  - **§7.5 render gate harness** run against `fixtures/sample-media/`.
- **Explicitly out of scope (and which later milestone owns it):**
  - **Feed, reactions, comments, montage download-url, `DELETE /montages/:id` (user delete)** → **M8** (social half of the loop).
  - **`POST /montages/:id/replace`, expiry/cleanup jobs, raw-media 60-min-grace purge, the 24h hard-delete contract, S3 lifecycle defense-in-depth, audit-log tombstones** → **M9** (ephemerality). *M7 publishes; M9 owns everything about deletion/expiry except render-failure cleanup, which M7 must do itself.*
  - **Remotion Lambda** (autoscaling) → future (documented interface drop-in, not built).
  - **Real licensed music + real face-detection model** → §13 / P2 (placeholders + heuristics here, loudly flagged).
  - **Theme/music *picker* UI polish, captured-thumb camera screen** → camera is M6; theme/music selection in M7 is functional (defaults + a basic picker fed by `GET /montages/options`), full design polish later.
  - **Push "recap-ready" notification** → M11 (client polls `GET /montages/:id` here).
  - **Capture attestation / forgeable-freshness fix** → P2.

## 3. Tasks (ordered checklist)
- [ ] **Contracts — EDL schema.** In `packages/contracts/src/edl.ts`: a `.strict()` Zod schema — `width: z.literal(1080)`, `height: z.literal(1920)`, `fps: z.literal(30)`, `durationMs: z.literal(30000)`, `musicId`, `themeStyle` (enum-driven pacing/transition/overlay block), `audio: { musicId, srcRef, beatGrid: number[] }`, `segments: [{ mediaRef, mediaType, inMs, outMs, startMs, transition, overlay? }]`, `beatGrid: number[]`. Add a runtime invariant test that `Σ segment durations == 30000` and every cut start lands on/near a beat. Export the inferred `Edl` type.
- [ ] **Contracts — montage DTOs + enums + errors.** `montageStatus` enum (`not_generated|generating|draft_ready|published|failed|deleted_by_user|removed_by_admin|expired`); `theme` enum; request/response DTOs for `POST /montages`, `GET /montages/:id`, `regenerate`, `options`, `publish`; error codes (`RENDER_FAILED_RETRYABLE`, `MONTAGE_ALREADY_GENERATING`, `NOT_ENOUGH_MEDIA`, `MONTAGE_NOT_OWNED`, `GROUP_NOT_MEMBER`, `RECAP_ALREADY_TODAY`).
- [ ] **Migration — `montage` + `montage_group_visibility`** (see §4). Include the `published ⇒ expiry_at NOT NULL` CHECK and the partial index. Add to the drizzle schema set (enums included).
- [ ] **Worker scaffold (Node).** `services/worker`: BullMQ `Worker` + `Queue` for `render-montage`, ioredis connection from `REDIS_URL`, concurrency **1**, **`jobId` uses `-` not `:`** (recap §5/§8.10 — `:` silently breaks delayed scheduling), 5-min `timeout`/`stalledInterval`, **`attempts: 2`** (= one auto-retry). Boot as a separate `bun`-spawned-but-Node-executed process (or `node` directly) so Remotion runs on Node.
- [ ] **Bundled music + precomputed beat grids.** `infra/remotion/src/music/`: ~4 placeholder synth/CC0 tracks; an **offline** script (`scripts/precompute-beatgrids.ts`) that runs the essentia.js WASM beat detector once per track and writes `*.beatgrid.json` next to each. Check in the grids. (Request-time path reads the JSON; it never re-runs essentia.)
- [ ] **Intelligence — scoring.** `services/worker/src/intelligence/scoring/score.ts`: per-clip heuristics (motion via inter-frame diff on sampled frames, sharpness via Laplacian variance, brightness, loose-face heuristic), flat score for photos. **Pure, directly importable** (no essentia import in this module).
- [ ] **Intelligence — EDL builder.** `services/worker/src/intelligence/edl/build.ts`: takes `{ track (with precomputed beatGrid), scoredClips, theme }` → `Edl`. Beat-aligned segment allocation + per-theme pacing. **Directly importable** (no barrel — recap §5).
- [ ] **`Renderer` interface + `RemotionRenderer`.** `services/worker/src/render/Renderer.ts` (interface) + `RemotionRenderer.ts`: `bundle()` once (cache), `selectComposition(edl)`, `renderMedia({ codec: 'h264', ... })`. Apply the perf knobs (§10). Stub a `LambdaRenderer` *file header comment* only (documented drop-in), do not implement.
- [ ] **Media server for render.** `startMediaServer()` — Chrome blocks `file://`, so download selected raw media from S3 to a temp dir and **serve over local HTTP**; pass an **out-of-band `srcMap`** (mediaRef → http URL) to the composition. Tear down + temp cleanup in `finally`.
- [ ] **`<Montage/>` composition.** `infra/remotion/src/Montage.tsx` + `Root.tsx`: composition `id="Montage"`, `width=1080 height=1920 fps=30 durationInFrames=900`, props = `Edl` + `srcMap`; render segments on a timeline (`Sequence`/`OffthreadVideo`/`Img`), apply transitions/overlays per `themeStyle`, lay the `audio` track. Thumbnail = `renderStill` at a representative frame.
- [ ] **render-montage job.** Orchestrate: load montage row + `source_media_ids` (honor `mediaIds` from the request) → fetch + score clips → pick track → build EDL → persist `edl` jsonb → `RemotionRenderer.render(edl)` → upload mp4 to `montages` bucket + thumb to `thumbnails` → set `video_path`/`thumbnail_path`/`duration_ms`, `status=draft_ready`. **On any throw:** cleanup any partially-written S3 objects, on 2nd attempt set `status=failed` (retryable error surfaced to client).
- [ ] **API — `POST /montages`.** Auth + owns-the-day check; reject if `< N` valid media (`NOT_ENOUGH_MEDIA`); **guard concurrent generate** (if a montage for today is already `generating`, return that one / `MONTAGE_ALREADY_GENERATING`); create row `status=generating`, enqueue `render-montage` (jobId = `montage-<id>`), return **202** `{ montageId, status: "generating" }`. Idempotency key honored; **claim released on op-throw** (recap §5).
- [ ] **API — `GET /montages/:id`.** Owner-only; returns status (+ signed thumbnail/preview URLs once `draft_ready`, TTL ≤ remaining lifetime). This is the client poll target.
- [ ] **API — `POST /montages/:id/regenerate`.** Same concurrency guard; re-enqueue; **remove-media-and-regenerate** = caller passes the trimmed `mediaIds`. Honor `mediaIds`.
- [ ] **API — `GET /montages/options`.** Returns available themes + bundled music tracks (id, title, duration) for the picker. Public-to-authed.
- [ ] **API — `POST /montages/:id/publish`.** Owner-only; body = `groupIds[]`; verify membership of **each** group (`GROUP_NOT_MEMBER`); enforce **one recap per user/group/day** (`RECAP_ALREADY_TODAY`); insert `montage_group_visibility` rows (idempotent — re-publish to same set is a no-op); set `status=published`, `published_at=now`, `expiry_at=published_at+24h`. **Idempotency key** on publish; claim released on throw.
- [ ] **Mobile — generating/progress screen (§9.2 missing-design).** After `POST /montages` 202, poll `GET /montages/:id`; show indeterminate/progress + estimated wait; cancel returns to today. Transition to review on `draft_ready`, to render-fail state on `failed`.
- [ ] **Mobile — review screen (§9 missing-design).** Inline **mp4 preview** (plays on-device), **expiry info** ("deleted 24h after publish"), **group multi-select** (from `GET /groups`), **theme/music** (from `GET /montages/options`), **regenerate**, **remove-media-and-regenerate** (drops items → regenerate with trimmed `mediaIds`), **publish** → success.
- [ ] **§7.5 render gate harness.** Live-stack test (below) against `fixtures/sample-media/`.
- [ ] **Acceptance run** on a real Android device (§8).

## 4. Data model & migrations
Migration `00xx_montage` (per-domain, after M4's media migration):

- **`montage`** — `id` uuid PK (pgcrypto) · `user_id` FK→user · `day_bucket` date · `video_path` text NULL · `thumbnail_path` text NULL · `duration_ms` int · `status` `montage_status` enum(`not_generated,generating,draft_ready,published,failed,deleted_by_user,removed_by_admin,expired`) · `theme` text · `music_id` text · `edl` **jsonb** NULL · `source_media_ids` uuid[] · `render_job_id` text NULL · `created_at` timestamptz · `published_at` timestamptz NULL · `expiry_at` timestamptz NULL.
  - **CHECK** `status <> 'published' OR expiry_at IS NOT NULL` (published ⇒ expiry set — recap as-built §2).
  - **Partial index** `montage_published_status_expiry_idx ON (status, expiry_at) WHERE status = 'published'` (drives feed M8 + expiry sweeps M9).
  - **Unique guard** for "one recap per user/group/day": enforced via `montage_group_visibility` insert + a per-`(user_id, day_bucket)` uniqueness on the *generating/published* recap (partial unique index, or app-layer check on publish — pick app-layer to allow regenerate-before-publish).
- **`montage_group_visibility`** — `montage_id` FK · `group_id` FK · PK(`montage_id`,`group_id`). Drives one-render→many-groups (Q1) + per-group feed authz (M8).
- **Enums:** add `montage_status` and (if not from M4) `theme` to `enums.ts` so drizzle-kit emits `CREATE TYPE`.

## 5. API endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/montages` | session | Generate today's montage: validate media count + ownership, guard concurrent generate, create row `status=generating`, enqueue `render-montage`, return **202** `{ montageId, status }`. |
| GET | `/montages/:id` | session (owner) | Status poll; signed thumbnail/preview URLs once `draft_ready`. Client polls this. |
| POST | `/montages/:id/regenerate` | session (owner) | Re-enqueue render (concurrency-guarded); `mediaIds` optional → remove-media-and-regenerate. |
| GET | `/montages/options` | session | Available themes + bundled music tracks for the picker. |
| POST | `/montages/:id/publish` | session (owner) | Publish to `groupIds[]` (membership-checked each), one-recap-per-group/day, insert visibility rows, set `published`/`published_at`/`expiry_at`. Idempotent. |

(`/montages/:id/replace` → **M9**; `/montages/:id/download-url`, `DELETE /montages/:id` → **M8**; `reactions`/`comments`/`feed` → **M8**.)

## 6. Mobile (Expo Go, Android)
- **Generating/progress screen** (§9.2 missing-design): poll loop on `GET /montages/:id`, indeterminate/progress + estimated wait + cancel.
- **Review screen** (§9 missing-design): on-device mp4 preview (`expo-av`/`expo-video`), expiry info copy, group multi-select, theme/music picker (fed by `GET /montages/options`), regenerate, remove-media-and-regenerate, publish → publish-success.
- **Render-failure state**: on `status=failed`, show the retryable error + retry (re-`regenerate`) (§9.4 missing-design — minimal build here).
- API client (`packages/api-client`): typed methods for all five routes, consuming `contracts` DTOs.
- Store: a montage store (zustand) tracking the in-flight montage id + poll status; reuses today-bucket media ids for `mediaIds`.

## 7. Tests (live-stack)
Run against real Postgres + Redis + MinIO + a real Remotion render (recap: this is the suite that "caught a real bug nearly every slice"). The render gate uses **`fixtures/sample-media/`** as the §7.5 fixtures.

- **§7.5 render gate harness** (against `fixtures/sample-media/`, ~10–30 mixed photos/videos): enqueue a real `render-montage`, then assert the produced mp4 (via ffprobe) is **1080×1920**, **30fps**, **30s ± 0.2s**, **h264**, **beat-aligned** (segment cut starts coincide with the track's precomputed beat grid within tolerance), and a thumbnail exists. **Perf:** assert **p95 < 120s** across repeated runs (p50 < 60s target).
- **Honor `mediaIds`:** generate with an explicit subset; assert the EDL `source_media_ids` / segments use exactly that subset (and remove-media-and-regenerate produces a render without the dropped items).
- **Render-failure retry-once:** inject a failing render (e.g. a corrupt/oversize fixture or a forced throw) → assert the job runs **exactly twice** (attempts=2), ends `status=failed`, and surfaces `RENDER_FAILED_RETRYABLE`.
- **No orphaned objects:** after a forced render failure, assert **zero** stray objects in `montages`/`thumbnails` for that montage (cleanup-on-failure).
- **Concurrent-regenerate guard:** two near-simultaneous `POST /montages` / `regenerate` for the same day → exactly **one** in-flight render; second returns the existing one / `MONTAGE_ALREADY_GENERATING`.
- **Status machine:** `not_generated → generating → draft_ready → published`; `GET /montages/:id` returns signed preview URL only once `draft_ready`.
- **Idempotent publish:** publishing the same montage to the same `groupIds` twice yields one set of `montage_group_visibility` rows; idempotency claim **released on op-throw**.
- **One recap per user/group/day:** a second publish into a group that already has today's recap → `RECAP_ALREADY_TODAY`.
- **Authz:** non-owner `GET`/`publish` → 403; publish to a non-member group → `GROUP_NOT_MEMBER`.
- **EDL contract:** `.strict()` schema rejects extra keys / wrong literals; `Σ` segment durations == 30000.
- **BullMQ jobId:** assert jobId contains no `:` (delayed scheduling regression guard).

## 8. Acceptance criteria
- `POST /montages` returns **202** and enqueues; `GET /montages/:id` polls through `generating → draft_ready`.
- A **real 1080×1920 / 30fps / 30s±0.2 / h264** montage, beat-aligned to a bundled track and themed, is produced from `fixtures/sample-media/`, with a thumbnail; **p95 < 120s** on the single worker.
- Render failure auto-retries **once**, then surfaces a **retryable** error; **no orphaned S3 objects**; **5-min hard timeout** enforced.
- Concurrent regenerate is guarded to one in-flight render.
- `POST /montages/:id/publish` writes `montage_group_visibility` for multiple groups, sets `published_at`/`expiry_at = +24h`, enforces **one recap per user/group/day**, and is **idempotent**.
- **Android device check (required):** on a real Android device in Expo Go — capture/import media (M6) → **generate** (see the generating screen) → **review** (the produced mp4 **plays back on-device**) → **publish** to ≥1 group → publish-success. The same mp4 is fetchable via a signed GET.

## 9. Dependencies & prerequisites
- **From prior milestones:** M0 (Redis + MinIO `montages`/`thumbnails` buckets + `fixtures/sample-media/` populated), M1 (error envelope/content-type/CORS), M2 (`requireSession`), M3 (group membership), M4 (presign + `daily_media_item` + day_bucket), M6 (media actually in today's bucket).
- **`fixtures/sample-media/` MUST be populated** with the user's ~10–30 mixed photos/videos — these **are** the primary §7.5 render-gate inputs.
- **Libs:** `bullmq`, `ioredis`; `@remotion/renderer` + `@remotion/bundler` + `remotion` (Node); `essentia.js` (WASM, beat detection — offline precompute only); `sharp`, `exifr` (scoring); AWS S3 SDK (worker-side upload/download); `ffprobe` static binary (gate assertions); `zod` (EDL).
- **Runtime:** worker runs on **Node** (Remotion caveat); API/contracts/tests on Bun.
- **Env:** `REDIS_URL`, `S3_*` + bucket names, `REMOTION_CONCURRENCY` (default 1), `RENDER_TIMEOUT_MS` (300000), `RENDER_GL` (default **null**), `CHROMIUM_*` knobs, `MEDIA_SERVER_PORT`.

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md)
- **§5 / §8.6 — `chromiumOptions.gl` MUST be `null`, not `'angle'`** (~9× faster; `'angle'` serializes rasterization through one GPU process). Default `RENDER_GL=null`; pair with concurrency + x264 `veryfast` + `crf 23` + a shared cached browser → ~20–70s renders within budget. All knobs env-overridable.
- **§5 / §8.6 — Chrome blocks `file://` media** → `startMediaServer()` + **out-of-band `srcMap`** (mediaRef → HTTP URL) passed to the composition; never hand the composition a `file://` path.
- **§5 / §8.6 — import scoring/EDL builders DIRECTLY, not via the `intelligence` barrel** — the barrel pulls untyped `essentia.js`, which breaks API `tsc` when the API imports `@twenty4/worker`. Keep scoring/EDL modules essentia-free and individually importable.
- **§2 / §5 — EDL is a `.strict()` Zod schema** with `1080×1920 / 30fps / 30000ms` **literals**; lives in `packages/contracts`; the composition, API, and worker all consume the one schema.
- **§5 / §8 — idempotency lib must release the claim on op-throw** (publish + generate). Subtle retry-safety requirement.
- **§5 / §8.10 — BullMQ custom `jobId` CANNOT contain `':'`** — use `'-'` (a `:` silently breaks delayed-job scheduling, the exact mechanism M9's 24h expiry relies on).
- **§2 / §6 — Renderer runs on Node**, everything else Bun (the Bun caveat). Worker process is Node-executed.
- **§5 / §6 — render throttle** (concurrency 1, shared browser instance, 5-min hard timeout, attempts=2 = one retry) and **no orphaned S3 objects on failure** (cleanup in the job's `finally`/catch).
- **§6 / §9 — montage carries `edl` jsonb + `source_media_ids`; `published ⇒ expiry_at NOT NULL` CHECK; partial index on `(status, expiry_at) WHERE status='published'`** (as-built shape worth keeping).
- **§7.5 — keep render as an explicit early gate** validated on the mixed-media fixture set + a track (beat-synced, watchable, 9:16/30s, within time target) — exactly what the gate harness asserts.
- **§6 — keep the swappable `Renderer` interface** — it's what makes the Remotion→Lambda path a clean later drop-in with no contract change.

## 11. Open decisions / flags
- **Music licensing [§13 NEEDS DECISION — founder call].** Real catalog vs bought royalty-free pack is a commercial/legal choice that gates store approval. **Default for M7:** ~4 **placeholder synth / CC0** tracks with **checked-in precomputed beat grids**; loudly flagged. Real tracks + grids swap in without code change (read the same `*.beatgrid.json`).
- **Minimum media to generate (`N`).** Not spec-pinned. **Default:** require ≥ a small floor (e.g. 3 valid items) so a 30s cut isn't a single held photo. Tune with the fixture set.
- **Loose-face heuristic vs real detector.** MVP ships a cheap heuristic (no model), flagged for a tiny face-detector upgrade (the EDL contract is unchanged). **Default:** heuristic.
- **`processing_status` vs `validation_status` overlap** (resolved in M4) — M7 reads only the reconciled "is this media usable for a render" state; if M4 deferred it, M7 treats `validation_status=valid` as the gate.
- **Renderer concurrency.** Single worker, concurrency 1 for the prototype (Q9). **Default:** 1; `REMOTION_CONCURRENCY` env knob for tuning the gate's p95.
- **Remotion Company License [§13 — budget, not a blocker].** Applies once team > 3 (~$100/mo). Track as a cost; no engineering gate.
- **Infra note:** README locks **Docker compose**; recap notes the actual WSL box ran no-Docker (`:5433`, MinIO flaky under test load — restart-to-fix). M7's live-stack tests assume the single canonical infra story from M0; if MinIO flakes under render-test load, the remedy is restart, not a second infra path.
