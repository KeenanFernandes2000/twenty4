# M2 — Auth
> Spec phase: P1 · Depends on: M0 (foundations, drizzle single-copy + dedupe lever), M1 (API skeleton: error envelope, content-type parser, CORS, rate-limit scaffold) · Branch commit: one commit on `rebuild/v2`

## ✅ Status: BACKEND IMPLEMENTED & HARDENED (2026-06-24)
Built on `rebuild/v2` — commit `d34e512`. Backend complete; live-stack tests green. **On-device acceptance pending** (the user runs it).
- **Verified:** 52 `bun test` green incl. phone OTP + email-via-Mailpit happy paths, guarded-route 401, raw-BA-OTP 403, per-IP + per-identifier 429 throttle, suspended/banned/deleted denied, requireAdmin + audit_log, is_admin seed, logout-revokes. Single physical drizzle-orm preserved post-better-auth. lint + tsc clean. Migration `0001_auth` applied.
- **Adversarial hardening applied** (the v1 functional→hardening rhythm): account_status enforced on EVERY guarded request + `/auth/refresh` (was sign-in only — a suspended/banned/deleted bearer is now immediately locked out); per-IP OTP key off the socket addr (not spoofable `X-Forwarded-For`); identifier canonicalized (email lower/trim, phone +digits) before keying rate/verify counters + Better Auth (closes OTP brute-force / cap-bypass via case/format variants); deny-list case/slash-insensitive.
- **Pending (device):** §8 — from the phone over LAN/Tailscale: `/auth/start` (phone) → `/auth/dev/last-otp` → `/auth/verify` → guarded 200; repeat email channel reading the OTP from Mailpit web UI `http://<LAN-IP>:8025`.

## 1. Goal
Phone **and** email OTP sign-in works end to end on the Android device: a user requests an OTP for a phone number or email, verifies it, and receives a Postgres-backed (revocable) session. A `requireSession` preHandler gates protected routes; suspended/banned/deleted accounts cannot create sessions; raw Better Auth OTP HTTP routes are denied (403) so all OTP traffic funnels through one throttled `/auth` façade.

## 2. Scope
- **In scope:**
  - Better Auth 1.6 wired to our Postgres via the **Drizzle adapter**, sharing the single physical `drizzle-orm` copy pinned in M0.
  - **Phone OTP** (`phoneNumber` plugin) **and email OTP** (`emailOTP` plugin), plus `bearer` for session tokens.
  - **Sessions in Postgres** (Better Auth `session` table), server-listable and **revocable** (logout invalidates; admin can revoke).
  - A **`/auth` façade** — `POST /auth/start`, `POST /auth/verify`, `POST /auth/refresh`, `POST /auth/logout` — fronting Better Auth via **in-process `auth.api.*`** calls (not HTTP proxying).
  - **Deny-list the raw Better Auth OTP HTTP routes (403)** at the Fastify layer so OTP can only be requested/verified through the throttled façade.
  - **`requireSession`** preHandler + **`requireAdmin`** guard (admin actions written to `audit_log`).
  - **Account-status gate at session creation:** `suspended | banned | deleted` blocked; only `active` may mint a session.
  - **`is_admin` seed from `ADMIN_EMAILS`** env (comma-separated) at account create / on boot.
  - **OTP delivery transport (dual, per channel):**
    - **Email OTP → a real email service** following the project's canonical email pattern: **nodemailer → Mailpit in dev**, **SES in prod**, switched by `NODE_ENV`, with a **Handlebars** OTP template compiled at startup. Wired into Better Auth's `emailOTP.sendVerificationOTP`. This is the scaffolding for dropping in SES / SendGrid later with **zero call-site changes**.
    - **Phone OTP → dev console transport** (`console.log` + dev OTP store) until a real SMS vendor lands (M15).
    - A **dev-only `GET /auth/dev/last-otp?identifier=`** (gated behind `NODE_ENV !== 'production'` / explicit dev flag) for convenience on both channels.
  - **Per-identifier + per-IP rate limits** with an **env-configurable cap** (`OTP_MAX_PER_IP`, `OTP_MAX_PER_IDENTIFIER`, window envs).
  - User profile endpoints: `POST /users`, `PATCH /users/me`, `DELETE /users/me`.
  - DTOs (Zod) for all of the above in `packages/contracts`.
- **Explicitly out of scope (owned later):**
  - **Apple / Google / social login** → **M14** (interface-stubbed only; no provider wiring here).
  - **Contacts discovery** (`POST /users/me/contacts-discovery`) → onboarding work, not this milestone.
  - **Notification prefs endpoints** (`GET/PATCH /users/me/notification-prefs`) → **M11**.
  - **Real SMS transport for phone OTP** (Twilio / SNS) → launch hardening (**M15**); phone OTP uses a dev **console** transport until then. *(Email OTP transport is built **in** this milestone — Mailpit in dev, SES-ready for prod — see §3.)*
  - **Account-deletion purge mechanics** (S3 + cascade jobs) → **M9**. `DELETE /users/me` here marks the account `deleted` and revokes sessions; the purge job is M9's.
  - **Groups / membership authz** → **M3**.

## 3. Tasks (ordered checklist)
- [x] **Pre-flight (verify M0 lever):** confirm one physical `drizzle-orm` resolves across `services/api` and `packages/contracts` (`bun pm ls drizzle-orm` / dedupe check). Confirm `kysely` is a devDep on `@twenty4/contracts` and the dedupe flag is set. **Do not** add Better Auth until this is green.
- [x] **Schema (`packages/contracts/src/db/`):** add `user` table + Better Auth `session`, `account`, `verification` tables; add `auth_provider` and `account_status` pgEnums to `enums.ts`. Make `display_name`/`username` **nullable** (BA multi-step create). Add `is_admin boolean default false`. **Do not** add an email-or-phone PG CHECK (enforce at app layer).
- [x] **Migration:** generate Drizzle migration; confirm `enums.ts` is in the `schema` set so `CREATE TYPE` is emitted; confirm the first migration still prepends `CREATE EXTENSION citext, pgcrypto` (from M1). Apply + verify.
- [x] **DTOs (`packages/contracts`):** `AuthStartReq` (`{ identifier, channel: 'phone'|'email' }`), `AuthVerifyReq` (`{ identifier, channel, code }`), `AuthRefreshReq`, `SessionDTO`, `UserDTO`, `CreateUserReq`, `UpdateMeReq`. Export via the contracts barrel.
- [x] **Better Auth config (`services/api/.../auth/betterAuth.ts`):** Drizzle adapter; plugins `phoneNumber`, `emailOTP`, `bearer`; **BA field mapping uses Drizzle PROPERTY names** (`name: 'displayName'`, not `'display_name'`). Set `advanced.generateId` to special-case `user`/`users` → `false` (let PG generate the uuid). Configure session store = PG, revocable.
- [x] **Phone-OTP signup:** provide `signUpOnVerification.getTempEmail` / `getTempName` so phone-only signup doesn't 500.
- [x] **Email service (`services/api/.../services/email.service.ts`)** — per the project's email-setup pattern: dual transport (nodemailer → **Mailpit** when `NODE_ENV !== 'production'`, **SES** otherwise), Handlebars templates compiled once at startup, `stripHtml` plain-text fallback. Add an `otp.hbs` template branded with the **Ember** tokens (dark header, gradient CTA). Export `sendOtpEmail(email, { code, ttlMinutes })`.
- [x] **OTP transport (`auth/otpTransport.ts`)** — routes by channel: **email** → `sendOtpEmail` (**await + surface failure** to the caller — OTP send is *not* fire-and-forget; the user must learn if it failed); **phone** → `console.log` + write last OTP to a dev store (Redis key) for `/auth/dev/last-otp`; real SMS deferred to M15. Wire BA `emailOTP.sendVerificationOTP` → the email path. Note phone OTP is **plaintext-at-rest** (accepted P1 limit); email OTP hashed by BA.
- [x] **`/auth` façade routes:** `start` → `auth.api.sendPhoneOtp` / `sendVerificationOtp` by channel; `verify` → BA verify → run **account-status gate** → mint session; `refresh`; `logout` → revoke session. All four go through the rate-limit preHandlers.
- [x] **Account-status gate:** at session-create, load the user's `account_status`; reject `suspended|banned|deleted` with the proper error-envelope code (e.g. `403 ACCOUNT_SUSPENDED` / `ACCOUNT_BANNED` / `ACCOUNT_DELETED`).
- [x] **`is_admin` seed:** on account create (and a boot reconciliation pass), set `is_admin = true` where the user's email ∈ `ADMIN_EMAILS`.
- [x] **Deny raw BA OTP HTTP routes (403):** register a Fastify preHandler/hook denying the BA OTP HTTP paths (send/verify for both phone + email-otp, ~the known BA OTP path set) so they can't bypass the throttle. The façade uses `auth.api.*` in-process and is unaffected.
- [x] **`requireSession` preHandler:** resolve bearer/session token → attach `request.user`; 401 (error envelope) when absent/invalid/expired/revoked.
- [x] **`requireAdmin` guard:** requires `requireSession` + `request.user.is_admin === true`; every admin action writes an `audit_log` row (`actor_id`, `action`, `target_*`, `metadata`). 403 otherwise.
- [x] **Rate limits:** per-IP and per-identifier counters (Redis) on `/auth/start` (and verify-attempt cap), caps from env (`OTP_MAX_PER_IP`, `OTP_MAX_PER_IDENTIFIER`, `OTP_WINDOW_SEC`); env-configurable so CI is deterministic.
- [x] **User endpoints:** `POST /users` (create profile post-verify; enforce email-or-phone present at app layer; unique citext `username`), `PATCH /users/me` (display_name/username/photo), `DELETE /users/me` (mark `deleted` + revoke sessions; purge deferred to M9).
- [x] **Wire all routes** behind the error envelope + content-type parser + CORS (incl. POST/PATCH/DELETE) from M1.
- [x] **Tests** (see §7) green against the live stack.

## 4. Data model & migrations
**Tables touched:**
- `user` — `id` PK (uuid, PG-generated) · `display_name` (nullable) · `username` (citext, unique, nullable) · `profile_photo_url` (nullable) · `email` (citext, nullable) · `phone` (nullable) · `auth_provider` enum(phone,email,apple,google) · `account_status` enum(active,suspended,banned,deleted) default `active` · `is_admin` boolean default false · `notification_prefs` jsonb · `privacy_settings` jsonb · `created_at` timestamptz.
  - **No PG CHECK** for email-or-phone (can't be DEFERRABLE with BA's multi-step create); invariant enforced in `POST /users` at the app layer.
- Better Auth tables: **`session`** (revocable, PG-stored), **`account`**, **`verification`** — created per BA's Drizzle schema, field-mapped by Drizzle property names.

**Enums (in `enums.ts`, included in the migration `schema` set):** `auth_provider`, `account_status`.

**Migration name(s):** next sequential Drizzle migration (e.g. `0002_auth.sql` depending on M1's count). Confirms `CREATE TYPE` emission for the two enums; `CREATE EXTENSION citext, pgcrypto` already prepended in the first migration.

## 5. API endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/start` | none (rate-limited) | Request an OTP for `{ identifier, channel }` (phone or email); funnels through throttle + transport. |
| POST | `/auth/verify` | none (rate-limited) | Verify OTP; runs account-status gate; mints a PG session + returns bearer token. |
| POST | `/auth/refresh` | session/bearer | Refresh/rotate the session token. |
| POST | `/auth/logout` | session/bearer | Revoke the current session. |
| GET | `/auth/dev/last-otp?identifier=` | **dev-only** (403 in prod) | Return the last OTP for an identifier (dev transport convenience). |
| POST | `/users` | session (post-verify) | Create profile; app-layer email-or-phone + unique-username enforcement. |
| PATCH | `/users/me` | session | Update own display_name / username / profile photo. |
| DELETE | `/users/me` | session | Mark account `deleted` + revoke sessions (purge → M9). |

**Denied (403, raw BA):** the Better Auth OTP HTTP routes (phone-OTP send/verify, email-OTP send/verify) — blocked at the Fastify layer so OTP only flows via the façade.

## 6. Mobile (Expo Go, Android)
**None for production screens** — auth screens are built in **M5** (mobile shell). This milestone's Android check exercises the API from the device via a thin harness / `curl` over LAN (or the M5 client if already present). No app screens are added here.

## 7. Tests (live-stack)
Against real Postgres + Redis (the same live-stack approach from M1):
- **OTP happy path — phone:** `start(phone)` → fetch code via `/auth/dev/last-otp` → `verify` → asserts a session row exists in PG and the bearer authenticates a guarded route.
- **OTP happy path — email:** same flow with `channel:'email'`, reading the code from **Mailpit's REST API** (`GET http://localhost:8025/api/v1/messages`) to assert the email was actually delivered + rendered; asserts session minted.
- **Guarded route → 401:** call a `requireSession`-protected route with no / invalid / expired / revoked token → `401` with the error envelope.
- **Raw-BA-OTP route → 403:** POST directly to a Better Auth OTP HTTP path → `403` (must not send an OTP).
- **Throttle behavior:** exceed `OTP_MAX_PER_IP` and `OTP_MAX_PER_IDENTIFIER` → `429`; assert the cap is read from env (set a low cap in test to keep it deterministic).
- **Suspended-account session-create denial:** seed a `suspended` (and a `banned`, a `deleted`) user, run `verify` → session creation denied with the correct `403` code; assert **no** session row created.
- **`requireAdmin`:** non-admin → 403; admin (email in `ADMIN_EMAILS`) → allowed, and an `audit_log` row is written.
- **`is_admin` seed:** a user whose email ∈ `ADMIN_EMAILS` gets `is_admin = true` on create.
- **Logout revokes:** `logout` → the previously-valid token now 401s.
- (globalSetup flushes only OTP/rate-limit Redis keys for rerun determinism.)

## 8. Acceptance criteria
- Phone OTP and email OTP both complete `start → verify → session` end to end against the live stack; session rows are persisted in Postgres and revocable.
- `requireSession` returns 401 on missing/invalid/expired/revoked tokens; `requireAdmin` returns 403 for non-admins and audits admin actions.
- Direct calls to raw Better Auth OTP HTTP routes return **403**; all OTP flows only through `/auth/start|verify`.
- Suspended / banned / deleted accounts **cannot** mint a session.
- Rate limits trip at the env-configured caps (per-IP and per-identifier) and return 429.
- `is_admin` is seeded from `ADMIN_EMAILS`.
- All §7 tests green.
- **Android device check:** from the real Android device over LAN/Tailscale, run `POST /auth/start` (phone) → read the OTP via `GET /auth/dev/last-otp` → `POST /auth/verify` → use the returned bearer to hit a `requireSession`-guarded endpoint and get a 200. Repeat with `channel:'email'`, reading the OTP from the **Mailpit web UI (`http://<LAN-IP>:8025`)** to confirm real delivery. (No app UI yet — verified via the device's HTTP client / M5 harness.)

## 9. Dependencies & prerequisites
- **M0:** single physical `drizzle-orm` pinned; `kysely` devDep on `@twenty4/contracts`; dedupe lever set — **must exist before** adding Better Auth.
- **M1:** error-envelope, `'*'` content-type parser, CORS (POST/PATCH/DELETE), request logging, rate-limit scaffold, DB-verify-on-boot.
- **Libs:** `better-auth` 1.6.x with `phoneNumber`, `emailOTP`, `bearer` plugins; `drizzle-orm` (pinned); Redis client (rate-limit counters + dev OTP store); **`nodemailer` + `handlebars` + `@aws-sdk/client-ses`** (`@types/nodemailer` devDep) for the email transport.
- **Services:** Postgres (citext + pgcrypto), Redis, **Mailpit** (SMTP `:1025`, web `:8025`) — running per M0 infra (the user already runs Mailpit locally).
- **Env:** `ADMIN_EMAILS`, `OTP_MAX_PER_IP`, `OTP_MAX_PER_IDENTIFIER`, `OTP_WINDOW_SEC`, `OTP_VERIFY_MAX_ATTEMPTS`, `BETTER_AUTH_SECRET`, `NODE_ENV` (gates the dev OTP route); **email:** `MAILPIT_HOST`/`MAILPIT_PORT` (dev), `SES_FROM_EMAIL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (prod). Add all to `.env.example`.

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md §5)
- **drizzle-orm dual-copy clash (§5 Auth):** better-auth pulls `kysely`, which can make `services/api` resolve a *different* physical `drizzle-orm` than `contracts` → incompatible `PgColumn` types. Mitigated by the **M0 lever** (`kysely` devDep on the schema package + `.npmrc dedupe-peer-dependents=false`); this milestone **verifies it before** adding BA.
- **BA field mapping uses Drizzle PROPERTY names, not SQL columns** (§5): `name: 'displayName'`, not `'display_name'`.
- **Phone-OTP signup 500** (§5): provide `signUpOnVerification.getTempEmail` / `getTempName`.
- **PG CHECK can't be DEFERRABLE** (§5): **drop the email-or-phone CHECK**, enforce the invariant at the app layer (`POST /users`); make `display_name` / `username` **nullable** for BA's multi-step create.
- **`generateId` special-case** (§5): `user`/`users` → `false` so PG generates the uuid.
- **Raw BA OTP endpoints bypass throttling** (§5): **deny-list them (403)** at the Fastify layer; route all OTP through the hardened `/auth/start|verify` façade driving BA via in-process `auth.api.*`.
- **OTP test flakiness** (§5): make the per-IP / per-identifier OTP cap **env-configurable** for deterministic CI.
- **Phone OTP plaintext-at-rest** (§4 A15 / accepted limits): an **accepted P1 limitation** (BA 1.6); note it, email OTP is hashed. Carry as a P2 line item.
- **`generateId` + nullable + status gate** together let BA's multi-step create coexist with our `account_status` invariant.

## 11. Open decisions / flags
- **Email OTP transport is built here** (Mailpit dev → SES prod, one interface); going live only needs SES domain verification + production access (see the email-setup notes), **not** new code. **Phone OTP delivery remains a dev console stub** (`/auth/dev/last-otp`) until an SMS vendor (Twilio / SNS) is wired — **flagged open, owned by M15.**
- **Phone OTP plaintext-at-rest** — accepted P1 limitation (BA 1.6); revisit in P2.
- **Apple Sign-In** is mandatory **once any social login ships** (spec §11) — relevant at **M14**, not here; provider auth is interface-stubbed only.
- **Refresh semantics** — default: rotate the BA session token on `/auth/refresh`; revisit if BA's session model makes rotation a no-op (current default: extend/rotate the existing PG session).
- **`/auth/dev/last-otp` exposure** — default: enabled only when `NODE_ENV !== 'production'`; double-gate behind an explicit `ENABLE_DEV_OTP_ROUTE` flag if any staging env runs with prod-like `NODE_ENV`.
- **Exact BA OTP deny-list paths** — enumerate the concrete BA OTP HTTP path set at implementation time (the v1 build deny-listed ~16 paths); keep the list in one place and assert it in the 403 test.
