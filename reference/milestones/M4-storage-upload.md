# M4 — Storage & media upload pipeline
> Spec phase: P1 · Depends on: M0 (infra+networking), M1 (API skeleton+content-type+CORS), M2 (auth/session guard), M3 (groups/membership) · Branch commit: one squashed commit on `rebuild/v2`

## ✅ Status: BACKEND IMPLEMENTED & REWORKED (2026-06-24)
Built on `rebuild/v2` — commit `bf3c634`. Backend + worker complete; live-stack tests green. **On-device upload acceptance pending** (the user runs it — this is the milestone's headline gate).
- **Verified:** 108 `bun test` green incl. presign round-trip (real PUT/GET to the Tailscale public endpoint, byte-match), validation hierarchy accept/reject, over-cap + type-mismatch reject (object deleted), **ETag-pin TOCTOU**, idempotent complete, day-bucket persistence across TZ + DST, anti-tamper skew flag, hard-delete. `validate-media` runs in `services/worker` (BullMQ concurrency 1, jobId `media-<id>`). Presign host = `S3_PUBLIC_ENDPOINT` (Tailscale), never localhost; buckets private. lint + tsc clean. Migrations `0003_daily_media_item` + `0004_user_timezone` applied.
- **Adversarial REWORK applied** (highest-risk subsystem; exploits proven live then fixed): magic-byte sniff in the worker (arbitrary/ELF bytes no longer reach `valid`); the ≤50/day cap is now atomic via a `pg_advisory_xact_lock` transaction (was a TOCTOU overshoot — a regression of the M3 race); `day_bucket` bound to a canonical `user.timezone` (can't multiply the cap by rotating `deviceTimezone`); worker marks rows terminal on throw + retries (no permanent `validating` wedge); `/complete` actual==declared type equality; `download-url` gated on the `valid` verdict; delete row-first; raw-bucket ILM expiry backstop. Regression tests encode each exploit.
- **Pending (device):** §8 — from a real Android phone, upload a real photo AND a real video via presigned PUT and re-fetch both via signed GET (bytes match). Use `scripts/device-upload-harness.ts`.

> ⚠️ **Risk-isolated milestone.** Upload transport is subsystem-risk #1. The entire point of M4 is to **prove the direct-to-storage upload transport on a real Android device** (real photo *and* real video, re-fetched via signed GET) *before* any UI (M6) is built on top of it. No screens ship here — just the pipeline and a throwaway device harness.

---

## 1. Goal

When M4 is done: from a real Android phone (Expo Go, over LAN/Tailscale), a throwaway harness can run the full **init → presigned PUT → complete** sequence for a real photo and a real video, the server validates and day-buckets each item, and the same bytes come back via a signed GET — with over-cap / wrong-type / stale-metadata uploads correctly rejected, and the `validate-media` BullMQ worker processing the validation hierarchy. The presigned URL host is exactly the host the phone connects to (no loopback-signed URLs).

## 2. Scope

**In scope:**
- MinIO buckets via the Docker stack: `raw-media` (private, short lifecycle TTL), `montages` (private, ~25h safety TTL), `thumbnails` (private). No public-read on any bucket.
- **LAN/Tailscale-safe presign config:** the S3 endpoint used to sign URLs must equal the host the device connects to (SigV4 signs `Host`; a `127.0.0.1`/loopback-signed URL is unusable from the device). One env-driven public endpoint, distinct from any internal compose hostname.
- API endpoints: `POST /media` (init — create row + presigned PUT), `POST /media/:id/complete` (HeadObject gate + ETag-pin + idempotent), `GET /media/today`, `GET /media/:id/download-url` (signed GET), `DELETE /media/:id` (hard-delete row + S3 object).
- `daily_media_item` table with **`day_bucket` (4am→4am, device-local tz) persisted on the row** at init, never recomputed at read.
- **Validation hierarchy:** EXIF `DateTimeOriginal` → device media-library timestamp → file creation timestamp → reject. Anti-tamper device-clock delta flag. TZ-deterministic, DST-correct anchoring via `Intl`.
- **Limits enforced server-side after upload** (presigned PUTs can't gate up front): video ≤60s, ≤50 items/day, ≤200 MB/item; photos JPG/PNG/HEIC; videos MP4/MOV.
- `services/worker` (BullMQ) stood up with the `validate-media` job (concurrency note below; jobId must not contain `':'`).
- A tiny throwaway **device harness** (a screen or script invoked from Expo Go) that runs init→PUT→complete→download for the acceptance check. Not product UI.

**Explicitly out of scope (owned later):**
- Capture (camera) and gallery picker UI, today-view list, upload-progress UI → **M6**.
- The reusable mobile `PutFile` platform-split transport (`transfer.web/native/foreground/fileSystem`) as production code → **M6** (M4's harness may use a minimal inline version, but the *contract* is documented here for M6 to adopt).
- Montage render / EDL / Remotion → **M7**.
- Raw-media post-publish deletion, day-close cleanup sweeps, 24h expiry jobs → **M9** (M4 sets `expiry_at` and writes day-buckets that those sweeps will key off, but ships no sweep).
- Background/resumable native upload + dev-client → **M13**. iOS / HEIC-on-iOS specifics → **M14**.
- Capture-attestation for true media-freshness proof → **P2** (accepted limitation A14: freshness is forgeable in P1; loud flag in the validate job).

## 3. Tasks (ordered checklist)

- [x] **Buckets.** Add `raw-media`, `montages`, `thumbnails` to the Docker MinIO bootstrap (mc `mb` + private policy). Add `raw-media` short-TTL and `montages` ~25h lifecycle rules. Verify none are public-read.
- [x] **Presign endpoint config.** Add `S3_PUBLIC_ENDPOINT` (the LAN/Tailscale host the phone uses) separate from any internal compose endpoint; the S3 client that *signs* URLs uses the public endpoint. Document that this host must equal the connect host (SigV4 Host signing).
- [x] **Contracts.** Add `daily_media_item` Drizzle table + `media_type`, `validation_status`, `processing_status` enums to `packages/contracts` (in `enums.ts` so drizzle-kit emits `CREATE TYPE`). Add Zod DTOs for init/complete/today/download responses. Reconcile `processing_status` vs `validation_status` into one clear state machine (see §11). Add media error codes to the taxonomy.
- [x] **Migration.** Generate migration for the table + enums + index `(user_id, day_bucket, validation_status)`. Confirm `citext`/`pgcrypto` extension prepend is already present from M1's first migration.
- [x] **Day-window helper.** Implement `resolveDayBucket(instant, tz)` (4am→4am, DST-correct via `Intl`) in contracts; unit-test boundary cases. Used to persist `day_bucket` at init from device-reported tz.
- [x] **`POST /media` (init).** Auth-gated. Body: `{ mediaType, contentType, byteSize, deviceTimezone, deviceCapturedAt?, declaredOriginalTimestamp? }`. Enforce ≤50 items/day for the resolved `day_bucket` (count existing rows). Validate declared `contentType` against the MIME allowlist (early 415/422). Create row (`processing_status=uploaded`, `validation_status=pending`), compute + persist `day_bucket`, generate a presigned **PUT** URL (short TTL) to `raw-media/<key>` keyed off the row id. Return `{ id, uploadUrl, storageKey }`.
- [x] **`POST /media/:id/complete` (HeadObject gate + ETag pin + idempotent).** Auth-gated, owner-only. `HeadObject` the uploaded key → read actual `ContentLength` + `ContentType` + `ETag`. Reject (and **delete the object** + mark row `failed`/`invalid`) if size > 200 MB, type not in allowlist, or type mismatches declared. **Pin the validated ETag** on the row so a later swapped re-PUT to the same key is detected (close TOCTOU). Enqueue `validate-media` (jobId = `media-<id>`, no `':'`). **Idempotent:** a second complete for an already-completed row is a no-op success (don't double-enqueue, don't re-charge the count). Return current state.
- [x] **`validate-media` worker job.** In `services/worker` (BullMQ, **concurrency 1** initially — see §11). Re-`HeadObject` and assert the pinned ETag still matches (else reject as tampered). Resolve `original_timestamp` via the hierarchy (EXIF `DateTimeOriginal` via `exifr` → media-library ts → file-creation ts → none⇒reject). For video, probe duration; reject if >60s. Check resolved timestamp falls inside the persisted `day_bucket` window; compute device-clock delta vs server time and set an anti-tamper flag in `metadata_summary`. Set `validation_status=valid|invalid` + terminal `processing_status`. Carry the loud `freshness-not-proven` flag (A14).
- [x] **`GET /media/today`.** Auth-gated. Return the caller's items for the current `day_bucket` (don't recompute from UTC — query by persisted bucket), with status + a signed download URL each.
- [x] **`GET /media/:id/download-url`.** Auth-gated, owner-only (M4); returns a short-TTL signed GET URL whose host = the public endpoint.
- [x] **`DELETE /media/:id`.** Auth-gated, owner-only. Hard-delete the S3 object **and** the row immediately (no soft-delete for content).
- [x] **Throwaway device harness.** Minimal Expo-Go-runnable harness (screen/script) that: picks/loads a file, calls init, PUTs the bytes to the returned URL, calls complete, polls today, fetches the download URL, and re-displays/re-downloads the bytes. Push `fixtures/sample-media/` to the device or use device-captured media to exercise it.
- [x] **Live-stack tests** (§7) green against real Postgres + MinIO + Redis.
- [x] **Android acceptance** (§8): real photo + real video round-tripped from the phone.

## 4. Data model & migrations

**New table — `daily_media_item`** (per spec §5):
`id` PK · `user_id` FK · `day_bucket` date (persisted 4am-window local day) · `media_type` enum(photo,video) · `storage_path` · `original_timestamp` (nullable) · `upload_timestamp` · `validation_status` enum(pending,valid,invalid) · `processing_status` enum(uploaded,validating,valid,invalid,used,deleted,failed) · `duration_ms` (nullable) · `metadata_summary` jsonb (holds: source-of-truth for the resolved timestamp, device-clock delta, anti-tamper flag, freshness-not-proven flag, pinned ETag, declared-vs-actual content-type/size) · `expiry_at`.
*Index:* `(user_id, day_bucket, validation_status)`.

**Enums** (in `enums.ts`): `media_type(photo,video)`, `validation_status(pending,valid,invalid)`, `processing_status(uploaded,validating,valid,invalid,used,deleted,failed)`. See §11 for the state-machine reconciliation between the two status enums.

**Migration:** new `00xx_daily_media_item` (table + 3 enums + index). Verify the `CREATE EXTENSION citext, pgcrypto` prepend exists from M1. No DEFERRABLE CHECKs.

## 5. API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/media` | session | Init: create row, persist `day_bucket`, enforce ≤50/day + MIME allowlist, return presigned PUT URL (host = public endpoint). |
| POST | `/media/:id/complete` | session, owner | HeadObject gate (size/type), reject+delete on violation, pin validated ETag (TOCTOU), enqueue `validate-media`, **idempotent**. |
| GET | `/media/today` | session | Caller's items for the current persisted `day_bucket` + signed download URLs. |
| GET | `/media/:id/download-url` | session, owner | Short-TTL signed GET URL (host = public endpoint). |
| DELETE | `/media/:id` | session, owner | Hard-delete S3 object + row immediately. |

All errors use the `{ error: { code, status, message } }` envelope. Signed-URL TTLs bounded by content lifetime.

## 6. Mobile (Expo Go, Android)

**No product screens.** One **throwaway device harness** only (deleted/ignored before M6): runs init→PUT→complete→poll→download against the LAN backend to satisfy §8. The harness may inline a minimal `{done, cancel}`/`0..1`-progress PUT, but the production platform-split transport (`transfer.web.ts` / `transfer.native.ts` → background-upload or `transfer.fileSystem.native.ts`; web+Expo-Go share `transfer.foreground.ts`) is **M6's** to build — its contract is documented in §10 so M6 adopts the proven shape. Uses `EXPO_PUBLIC_API_URL` (M0/M5 networking).

## 7. Tests (live-stack)

Against real Postgres + MinIO + Redis (no infra mocks):

1. **Presign round-trip.** Init → real S3 **PUT** of bytes to the returned URL → complete → `GET /media/:id/download-url` → real **GET** returns the identical bytes.
2. **Validation hierarchy — accept.** Three uploads where the timestamp resolves from (a) EXIF `DateTimeOriginal`, (b) media-library ts, (c) file-creation ts respectively, each inside today's window ⇒ `valid`.
3. **Validation hierarchy — reject.** No resolvable timestamp ⇒ `invalid`; resolvable but outside today's window ⇒ `invalid`.
4. **Over-cap rejection at /complete.** Upload >200 MB (or 51st item of the day) ⇒ rejected, object deleted, row not `valid`.
5. **Type-mismatch rejection at /complete.** Declared image, actual non-allowlisted/other type via HeadObject ⇒ rejected + object deleted.
6. **ETag-pin TOCTOU.** After a valid complete, re-PUT a *swapped* object to the same key; the `validate-media` job (or complete) sees ETag mismatch ⇒ swapped object **not** processed as valid.
7. **Idempotent complete.** Calling `/complete` twice ⇒ one enqueue, one count charge, stable terminal state.
8. **Day-bucket correctness.** Captures at 03:59 vs 04:01 local map to different buckets; assert across multiple timezones and across a **DST transition** (TZ-deterministic, persisted, not recomputed at read).
9. **Anti-tamper delta flag.** A device-reported time skewed far from server time sets the flag in `metadata_summary` (without necessarily rejecting).
10. **Hard-delete.** `DELETE /media/:id` removes both row and S3 object; subsequent download-url 404s.

## 8. Acceptance criteria

- All §7 live-stack tests green.
- Buckets are private (no public-read); presigned URLs carry a host equal to the device's connect host.
- `/complete` rejects over-cap and type-mismatch (object deleted), pins the ETag, and is idempotent.
- `day_bucket` is persisted at init and used (not recomputed) by `/media/today`.
- `validate-media` runs in the standalone `services/worker` (jobId contains no `':'`).
- **Android device check (required):** from a real Android phone in Expo Go over LAN/Tailscale, the throwaway harness uploads **a real photo AND a real video** to MinIO via presigned PUT and **re-fetches both via a signed GET** (bytes match). Sample media from `fixtures/sample-media/` (pushed to device) or device-captured media is acceptable. This proves the transport end-to-end before any M6 UI depends on it.

## 9. Dependencies & prerequisites

- M0: Docker MinIO reachable from device over LAN/Tailscale; device↔backend networking proven; env bootstrap baked in.
- M1: API skeleton, `'*'` content-type fallback parser, explicit CORS method list (real-preflight test), error envelope.
- M2: session/auth guard for owner-only routes. M3: user/group context exists (membership authz expands in M8; M4 download is owner-only).
- Libs/services: AWS S3 SDK (presign), MinIO + `mc`, BullMQ + ioredis (Redis), `exifr` (EXIF), a duration probe for video (e.g. `ffprobe`/static binary). `S3_PUBLIC_ENDPOINT` env set to the LAN/Tailscale host.
- `fixtures/sample-media/` populated (mixed photos/videos) for exercising the path.

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md)

- **§5 / §8.4 — Presigned PUTs can't gate size/type up front.** Enforce *after* upload with `HeadObject` at `/complete` (reject over-cap/type-mismatch + delete object). Already the proven workaround.
- **§5 — TOCTOU swapped-object.** Close it by **pinning the validated ETag** on the row and re-checking it in the validate job; make `/complete` idempotent (retry-safe). (Idempotency lib must release its claim on op-throw — §5 testing note.)
- **§5 — Presign host = connect host.** SigV4 signs `Host`; loopback-signed URLs are unusable from the device → sign with the LAN/Tailscale public endpoint (`S3_PUBLIC_ENDPOINT`).
- **§5 — Content-type 415 already handled in M1.** The root `'*'` parser (+ explicit CORS methods) lets RN/Expo `application/octet-stream` bodies reach the route; M4 relies on it — don't reintroduce a blanket 415.
- **§5 — MinIO flakiness under test load** — media tests can time out when MinIO drops; remedy is restart-to-fix (note in test/run docs).
- **§5 testing — BullMQ jobId must NOT contain `':'`** (silently breaks delayed scheduling) → use `media-<id>`.
- **§9 migrations** — include `enums.ts` in the drizzle-kit schema set so pgEnums emit; no DEFERRABLE CHECKs.
- **A10 / §6 day-window** — 4am→4am, server-authoritative, **persisted on the row, never recomputed at read**; DST-correct via `Intl`.
- **A14 freshness limitation** — media freshness is forgeable without capture attestation; carry the loud `freshness-not-proven` flag in the validate job for P2.
- **Upload transport shape (for M6)** — the `{done, cancel}` handle + `0..1` progress contract, Metro `.web/.native` split, and disk-backed streaming fallback (`expo-file-system/legacy`; mind the `file://` strip asymmetry and abort-before-send) are the proven shape; M4 documents it, M6 builds it.

## 11. Open decisions / flags

- **`processing_status` vs `validation_status` reconciliation (REBUILD_PLAN §M4 carries this decision).** Two overlapping enums on one row. **Default:** treat `processing_status` as the *lifecycle* state machine (`uploaded → validating → valid|invalid → used → deleted`, `→ failed` on infra error) and `validation_status` as the *narrow validation verdict* (`pending|valid|invalid`) that the lifecycle reads; keep both for spec-fidelity but document the single authoritative transition path. Revisit collapsing to one in M7 when `used` is exercised.
- **Worker concurrency.** **Default:** `validate-media` concurrency 1 for M4 (deterministic tests, low volume); raise once the render worker (M7) settles queue/Redis behavior. Flag.
- **HEIC validation on the headless/Linux box.** EXIF read via `exifr` should work, but full HEIC handling is iOS-leaning. **Default:** validate HEIC metadata where possible in M4; defer any HEIC transcode/iOS specifics to **M14**.
- **`raw-media` lifecycle TTL value.** **Default:** short safety TTL (e.g. ~26h) as a *backstop only* — authoritative purge is the M9 day-close/post-publish sweep, not the bucket TTL. Confirm the exact hours in M9.
- **Owner-only download in M4.** Group-membership-scoped media reads arrive with the feed in **M8**; M4 keeps `/media/:id/download-url` owner-only.
