# M6 — Capture & today bucket

> ✅ Implemented & web-e2e-verified — **on-device (Expo Go) acceptance still pending** (the user's real-phone check). M6 is **backend-free: a pure client of M4** (no new tables/endpoints). Shipped: the §9.1 in-app **camera screen** (photo + video, front/back, flash, captured-thumbnail strip), **gallery import** (`expo-image-picker` multi-select), the **platform-split upload transport** (`PutFile` `{done,cancel}` + 0..1 progress; `transfer.web` → foreground XHR, `transfer.native` → `expo-file-system` streaming fallback), the **upload-manager store** (concurrency cap 3; retry/cancel/remove with server-row reclaim), the **today bucket + readiness** banner, and the **`bun run test:e2e:mobile`** verification tool (now 15 flows, +7 new M6 ones).

> Spec phase: P1 · Depends on: M4 (storage & upload pipeline: presigned PUT, day-bucket, validation, `{done,cancel}`/0..1 transport proven on-device), M5 (mobile shell: routing, theme/ui, api-client, auth) · Branch commit: one commit on `rebuild/v2` (merged only after the Android acceptance check passes)

## 1. Goal

On a real Android phone in Expo Go, a user can **capture a photo/video in-app** (the §9.1 missing-design camera screen, built here) **and import from the gallery**, watch **per-item upload progress** as each file streams to storage, and see both land in **today's bucket** (`GET /media/today`) with a remove option and an "enough content to generate?" readiness state.

## 2. Scope

- **In scope:**
  - **In-app camera** via `expo-camera` — **this is a §9 MISSING-DESIGN screen (§9.1), designed and built here:** photo + video capture, front/back switch, flash toggle, captured-thumbnail strip, "add to today."
  - **Gallery import** via `expo-image-picker` (multi-select photos/videos).
  - **Today view:** list today's items, remove an item, and an **"enough content to generate?"** readiness state (gates the M7 generate CTA).
  - **Upload subsystem** built on M4's transport — the **proven platform-split shape**:
    - a `PutFile` contract: `(args) => { done: Promise, cancel: () => void }` with a **0..1 progress** callback.
    - a **Metro platform split:** `transfer.web.ts` / `transfer.native.ts`.
    - **native** detects the background-upload native module and, when absent (Expo Go), **falls back to `expo-file-system` streaming** in `transfer.fileSystem.native.ts`.
    - **web + Expo-Go fallback share a foreground XHR** path in `transfer.foreground.ts`.
    - base `transfer.ts` throws "no platform implementation resolved" as a misconfiguration tripwire.
  - **Upload-progress UI** (§9 missing-design screen): per-item progress bar, in-flight/queued/failed states, **retry** on failure, cancel in-flight.
  - Full client sequence: `POST /media/upload-url` → PUT to storage with progress → `POST /media` (complete) → invalidate `GET /media/today`.
  - **Sample media:** reference `fixtures/sample-media/` (~10–30 mixed photos/videos, provided by the user) as the import-test inputs — **the same fixtures M7 renders.**
- **Explicitly out of scope (owner milestone):**
  - **Background/resumable upload + the real native upload module + dev-client → M13.** M6 ships the *fallback/foreground* path only (Expo Go reality); the native branch is present but untested until M13.
  - Montage generate / review / publish / themes / music → **M7** (uses the same `fixtures/sample-media/`).
  - Feed / reactions / comments → **M8**.
  - Raw-media purge, day-window-close cleanup, 24h expiry → **M9** (M6 surfaces today's bucket; deletion contracts are M9).
  - Capture attestation / non-forgeable freshness → P2.
  - iOS / save-to-gallery → **M14**.

## 3. Tasks (ordered checklist)

- [x] `npx expo install --fix` for `expo-camera`, `expo-image-picker`, `expo-file-system` (don't hand-pick versions).
- [x] Request + handle camera + media-library permissions (Expo Go); permission-denied empty/error states.
- [x] **Build the camera screen (§9.1):** preview, capture photo, record/stop video, front/back switch, flash toggle, captured-thumbnail strip, "add to today." Style with Ember tokens from M5. *(video gated to native; web is photo-only.)*
- [x] **Gallery import:** `expo-image-picker` multi-select (photos + videos) → enqueue selected assets for upload.
- [x] **Upload subsystem (rebuild M4's proven shape):**
  - [x] Define `PutFile` contract: `{ done, cancel }` handle + 0..1 `onProgress`.
  - [x] `transfer.ts` (base) — throws "no platform implementation resolved."
  - [x] `transfer.web.ts` — delegates to `transfer.foreground.ts`.
  - [x] `transfer.native.ts` — detect background-upload module; if present use it, **else** delegate to `transfer.fileSystem.native.ts`; emit a one-time dev warning on fallback.
  - [x] `transfer.fileSystem.native.ts` — `expo-file-system/legacy` `createUploadTask` streaming (disk-backed); **keep the full `file://` URI** (do NOT strip).
  - [x] `transfer.foreground.ts` — XHR (not `fetch`, which can't report request-body progress); `aborted` flag + `AbortSignal` wired **before** `send()` so a cancel-before-send actually cancels.
- [x] **Upload manager/store:** queue of items with `{ id, asset, status: queued|uploading|done|failed, progress, error }`; per-item progress + retry + cancel; concurrency cap. *(`uploadStore`; cap 3; retry/cancel/remove best-effort `deleteMedia` to reclaim the orphan server row.)*
- [x] Client upload flow per item: `POST /media` (init → presigned `uploadUrl` + id) → PUT via `PutFile` (progress → store) → `POST /media/{id}/complete` → on success invalidate today query. *(real flow is 3-step, not a single `upload-url` call.)*
- [x] **Upload-progress UI (§9.3 missing-design):** per-item progress, queued/failed badges, retry button on failure, cancel for in-flight.
- [x] **Today view:** `GET /media/today`; render items; remove item (`DELETE /media/{id}`) with optimistic update; **"enough content to generate?"** readiness flag (e.g. ≥1/≥ threshold) feeding the M7 CTA. *(query self-stops its 3s poll once nothing is `validating`.)*
- [x] Wire `fixtures/sample-media/` as the import-test input set; document that M7 reuses it.
- [x] Update `RUNNING.md` with the camera/import device walkthrough.

### Implementation notes / decisions made

- **Real API flow is 3-step, not a single `upload-url` call.** Per item: `POST /media` (init → `{ id, uploadUrl }`) → PUT bytes to the presigned URL with progress → `POST /media/{id}/complete` (server `HeadObject`+ETag gate) → invalidate today. `api.mediaInit` requires the device IANA timezone (day-window resolution).
- **Imports send `declaredOriginalTimestamp = now`** so today's no-EXIF gallery photos validate. EXIF-bearing *old* photos are still correctly **rejected by the server** (anti-backfill preserved) — the client declaration only vouches for "captured now," it can't forge an old photo past the server's freshness check. **Product tradeoff:** a user *could* re-save an old image to strip EXIF and pass it off as today's — accepted for the MVP; non-forgeable capture attestation is the P2 fix.
- **`mediaInit` creates the `daily_media_item` row up front** — so it **counts toward the 50/day cap the moment you queue**, before PUT/complete. Therefore retry/cancel/remove each do a best-effort `deleteMedia(mediaId)` (`reclaimRow`) to free the orphan row; `done` items are never reclaimed.
- **Video capture is gated to native** (`VIDEO_SUPPORTED = Platform.OS !== 'web'`) — the web build is **photo-only** (matches the e2e/web QA path; on-device video is the native streaming-fallback case).
- **The today query polls only while an item is `validating`** (just-completed, worker running) — a self-stopping 3s poll. An `uploaded`-but-never-`complete`d row is treated as an **orphan**, not pending, so the poll doesn't spin forever on an abandoned init.

## 4. Data model & migrations

None new. M6 consumes the `daily_media_item` table (+ its enums `media_type`, `validation_status`, `processing_status`) and the storage buckets already shipped in **M4**. No migrations. (Note: §13/REBUILD_PLAN §6 flags reconciling `processing_status` vs `validation_status` into one state machine — that decision is owned by **M4**, not M6.)

## 5. API endpoints

None new — M6 is a **client** of M4's media endpoints:
- `POST /media/upload-url` — request a presigned PUT (LAN/Tailscale-safe host).
- `POST /media` — create the `daily_media_item` record after upload completes (server `HeadObject` + ETag-pin gate from M4).
- `GET /media/today` — list today's bucket (drives the today view + readiness state).
- `DELETE /media/{id}` — remove an item (hard-delete row + S3 object, per M4/§6).

## 6. Mobile (Expo Go, Android)

- **Screens:** Camera capture (§9.1, new design), Gallery import, Today bucket (list/remove/readiness), Upload-progress surface (§9.3, new design).
- **Upload lib** (`apps/mobile/src/lib/upload/`): `transfer.ts`, `transfer.web.ts`, `transfer.native.ts`, `transfer.fileSystem.native.ts`, `transfer.foreground.ts` (the proven Metro platform-split + streaming-fallback shape).
- **Stores:** upload-manager store (zustand) for the per-item queue/progress/retry; today query via react-query (invalidated on each completed upload / remove).
- **Components:** captured-thumbnail strip, per-item progress bar, retry/cancel controls, readiness banner.

## 7. Tests (live-stack)

- **Import → upload → today (web/Expo-web against live stack):** import items from `fixtures/sample-media/` → run the foreground transport → assert each completes and then **appears in `GET /media/today`**.
- **Progress callback:** assert `onProgress` emits monotonic 0..1 values and resolves at 1 on completion.
- **Cancel:** start an upload, `cancel()` mid-flight → assert it aborts and the item lands in `failed`/cancelled, not `done`; assert **cancel-before-`send()`** is honored (the abort-before-send guard).
- **Retry:** force a failure (e.g. bad presign / interrupted PUT), then retry → assert success and today reflects it.
- **Remove:** `DELETE /media/{id}` → item gone from `GET /media/today`.
- **Readiness state:** asserts the "enough to generate?" flag flips at the threshold.
- (Native streaming + background-module branch are device-verified manually, not in headless CI — see acceptance.)

## 8. Acceptance criteria

- Camera screen (§9.1) and upload-progress surface (§9.3) exist and are styled with Ember tokens.
- Per-item upload progress is visible; failures are retryable; in-flight uploads are cancellable.
- Items appear in `GET /media/today`; removal works; the readiness state reflects current count.
- **Android device check (primary):** on a real Android phone in Expo Go, **capture a video in-app AND import a photo** — both upload (via the `expo-file-system` streaming fallback) with **visible progress** and **land in today's bucket**.

## 9. Dependencies & prerequisites

- M4: presigned PUT with LAN/Tailscale-safe host, `daily_media_item`, `GET /media/today`, `DELETE /media/{id}`, the `HeadObject`+ETag-pin completion gate, and the device-proven `{done,cancel}`/0..1 transport.
- M5: api-client, auth/session, Ember theme + ui primitives, react-query, routing.
- `fixtures/sample-media/` populated by the user (~10–30 mixed photos/videos) — shared with M7.
- Libs (via `npx expo install --fix`): `expo-camera`, `expo-image-picker`, `expo-file-system`.
- M0 device networking (LAN IP, `0.0.0.0` bind, WSL2 mirrored) so PUTs from the phone reach storage.

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md §5 — the four upload failure modes)

1. **Expo Go missing native module** — `react-native-background-upload` (`RNFileUploader`/`VydiaRNFileUploader`) is absent in Expo Go → `Upload.startUpload` derefs undefined. Mitigation: **presence check → transparent foreground/streaming fallback** + one-time dev warn (§5 Upload #1).
2. **Heap-OOM blob on large videos** — `fetch(uri).blob()` + XHR loads the whole file into the JS heap, fatal for big videos. Mitigation: **disk-backed `expo-file-system` streaming** (`createUploadTask`), heap stays flat (§5 Upload #2).
3. **SDK API moved** — `uploadAsync`/`createUploadTask` are on the **`expo-file-system/legacy`** subpath, not the root module (§5 Upload #3).
4. **Content-type 415 on the presigned PUT** — addressed at M4/M1 (root `'*'` parser + post-upload `HeadObject` gate); M6 must send the correct content-type on the PUT (§5 Upload #4 / API).
- **`file://` strip ASYMMETRY** — background-upload wants a **bare path (strip `file://`)**; the `expo-file-system` legacy path wants the **full `file://` URI (do NOT strip)** (§5 Upload).
- **Abort-before-send guard** — `xhr.abort()` is a no-op while UNSENT (e.g. during `await fetch(uri).blob()`), so a cancel in that window is silently lost and `send()` fires anyway. Mitigation: `aborted` flag + `AbortSignal` wired **up-front** and a bail **before `send()`** (§5 Upload / cancel bug).
- **Use the proven platform-split contract** (`{done,cancel}`/0..1, Metro `.web`/`.native` split, base-`transfer.ts` tripwire) rather than re-deriving it (§5 Upload; §9 "Keep").
- **`npx expo install --fix`** for the new native deps; don't guess versions (§8.2).

## 11. Open decisions / flags

- **"Enough content to generate?" threshold** — default: ≥1 valid item enables generate; surface a soft hint until a richer minimum is chosen (don't hard-gate the loop).
- **Upload concurrency** — default: small fixed cap (e.g. 2–3 concurrent) to avoid heap/network pressure on-device; tune on real hardware.
- **Video length/size client-side pre-check** — default: rely on M4's server-side `HeadObject` enforcement (≤60s, ≤200MB, MIME allowlist); add a client-side warning as a nicety, not a gate.
- **Captured-media local cleanup** — default: leave camera-captured temp files to OS/cache; explicit cleanup deferred.
- **Native background-upload branch** — present but **not exercised in M6**; full validation (and dev-client wiring) is **M13**.
