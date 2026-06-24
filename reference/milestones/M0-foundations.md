# M0 — Foundations
> Spec phase: P1 · Depends on: none (first milestone) · Branch commit: one squashed commit on `rebuild/v2` ("M0: bun monorepo + docker infra + device↔backend ping")

## ✅ Status: IMPLEMENTED & ACCEPTED (2026-06-24)
Built on `rebuild/v2` — commit `fd71436` (+ `5045905` script centralization). **All acceptance criteria met, including the on-device check.**

- **Verified (live stack):** `bun install` clean; `docker compose up` → Postgres 16/citext, Redis 7, MinIO (buckets `raw`/`montages`/`thumbnails`), Mailpit all healthy; `0000_init` applied → `citext` + `pgcrypto` present; `bun run dev` → `GET /health` 200 `{"status":"ok"}`; `bun test` green; exactly one physical `drizzle-orm` (kysely devDep + `.npmrc` dedupe lever in place).
- **Android device (required):** ✅ phone reaches `GET /health` over LAN/Tailscale — confirmed working on real hardware.
- **Deviations from plan (documented):**
  - **Docker IS available** on this WSL box, so the canonical infra is `docker-compose.yml` (the "no-Docker fallback" flag was not needed).
  - **Host ports remapped: Postgres `5433`→container 5432, Redis `6380`→6379.** Under Docker Desktop + WSL2, Windows-side Postgres/Redis shadow `localhost:5432`/`6379`, so a host-run API would hit the wrong service. MinIO 9000/9001 + Mailpit 1025/8025 are unshadowed. `.env`/`RUNNING.md` updated accordingly.
  - All run commands live in the **root `package.json`** (child packages are script-free) so Bun loads the single root `.env`.

## 1. Goal
On day one: the Bun workspace is scaffolded, Docker compose brings up Postgres 16 (citext) + Redis 7 + MinIO (with `raw`/`montages`/`thumbnails` buckets created), the API boots, and a **real Android device on Expo Go's network reaches `GET /health` over LAN/Tailscale and sees the JSON response.** Networking is proven first, not last.

## 2. Scope
- **In scope:**
  - Bun workspaces layout: `packages/contracts`, `packages/api-client`, `packages/config`, `services/api`, `services/worker`, `apps/mobile`.
  - Tooling: `tsconfig.base.json`, ESLint 9 (flat), Prettier, `bunfig.toml`, root `package.json` workspaces.
  - **Docker compose** for Postgres 16 (citext) + Redis 7 + MinIO + **Mailpit** (email capture for M2's email-OTP dev transport), plus a one-shot bucket-creation step (`raw`, `montages`, `thumbnails`). This is the *single* canonical infra story.
  - Drizzle wired in `packages/contracts` (`src/db/`), with `enums.ts` in the schema set and a **first migration that prepends `CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto;`**.
  - **Pin one physical `drizzle-orm`** (kysely devDep on `contracts` + `.npmrc dedupe-peer-dependents=false` / bun dedupe lever) **before** any auth lands.
  - Env strategy: `.env.example` (incl. `EXPO_PUBLIC_API_URL`), env loading, env bootstrap baked into the repo.
  - A trivial `GET /health` route on the API (full skeleton is M1).
  - Empty `fixtures/sample-media/` folder with a README telling the user to drop ~10–30 mixed photos/videos there for M6/M7.
- **Explicitly out of scope (later milestone owns it):**
  - `apps/admin` — **deferred** (M12 moderation/admin console).
  - Full API hardening: error envelope, content-type parser, CORS method list, DB-verify-on-boot, rate-limit scaffold, graceful shutdown → **M1**.
  - Better Auth wiring → **M2** (we only *pre-empt* the drizzle dual-copy clash here).
  - Real schema tables / migrations beyond the extensions bootstrap → **M2+** (per-domain).
  - Storage presign/upload routes → **M4**.
  - Mobile app code beyond verifying the device can reach the backend → **M5**.

## 3. Tasks (ordered checklist)
- [x] `git checkout -b rebuild/v2` off `main`.
- [x] Root `package.json` with Bun `workspaces`: `packages/*`, `services/*`, `apps/*`.
- [x] `bunfig.toml` (test runner config, registry); `.npmrc` with `dedupe-peer-dependents=false`.
- [x] `tsconfig.base.json` (ES2022, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `moduleResolution: bundler`); per-package `tsconfig.json` extending it.
- [x] `packages/config`: shared ESLint flat config + Prettier config, consumed by every workspace.
- [x] Scaffold each workspace with `package.json` whose `main` → `src/index.ts` (TS source, **no build step**): `packages/contracts`, `packages/api-client`, `services/api`, `services/worker`, `apps/mobile`.
- [x] **`docker-compose.yml`** (single canonical file at repo root) with services:
  - `postgres` — `postgres:16`, env `POSTGRES_DB/USER/PASSWORD`, port `5432:5432`, named volume.
  - `redis` — `redis:7`, port `6379:6379`.
  - `minio` — `minio/minio`, `command: server /data --console-address ":9001"`, ports `9000:9000` + `9001:9001`, **bound `0.0.0.0`** (default), named volume, `MINIO_ROOT_USER/PASSWORD`.
  - `minio-setup` — one-shot `minio/mc` container that waits for MinIO, sets an alias, and **`mc mb --ignore-existing` the three buckets** (`raw`, `montages`, `thumbnails`).
  - `mailpit` — `axllent/mailpit`, ports `1025:1025` (SMTP) + `8025:8025` (web UI). Local email capture for M2's email-OTP dev transport; the Mailpit↔SES swap is `NODE_ENV`-switched in app code (no infra change to go prod).
- [x] `.env.example`: `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, bucket names, `API_HOST=0.0.0.0`, `API_PORT`, `EXPO_PUBLIC_API_URL` (with a comment: set to the machine's **LAN/Tailscale IP**, not `127.0.0.1`), and **email envs** `MAILPIT_HOST`/`MAILPIT_PORT` (dev) + `SES_FROM_EMAIL`/`AWS_REGION` (commented, prod — for M2's email-OTP transport). Add a short script/README note to copy → `.env`.
- [x] `packages/contracts`: install `drizzle-orm` + `drizzle-kit`; add **`kysely` as a devDep** (the dedupe lever — proves day-one before auth); `src/db/schema/` with an `enums.ts` placeholder included in the drizzle-kit `schema` glob; `drizzle.config.ts`.
- [x] First Drizzle migration (`0000_init`) that **hand-prepends** `CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto;` (no domain tables yet — extensions + enum scaffolding only).
- [x] `services/api`: minimal Fastify-on-Bun app exposing `GET /health` → `{ status: "ok" }`, binding `API_HOST` (`0.0.0.0`) / `API_PORT`.
- [x] Verify `bun run dev` (API) boots and `curl http://localhost:$API_PORT/health` returns 200 from the host.
- [x] Create `fixtures/sample-media/` with a `README.md`: "Drop ~10–30 mixed photos/videos (JPG/PNG/HEIC, MP4/MOV) here. Used by M6 (import) and M7 (render) tests. Git-tracked folder, contents gitignored."
- [x] **Device-networking checklist** (run as a unit, document in `RUNNING.md`):
  - API binds `0.0.0.0` (not loopback).
  - `EXPO_PUBLIC_API_URL` set to the LAN/Tailscale IP.
  - WSL2: `networkingMode=mirrored` in `.wslconfig` (+ `wsl --shutdown`) **or** a `netsh portproxy` fallback.
  - MinIO bound `0.0.0.0` and reachable from the phone (`http://<LAN-IP>:9000/minio/health/live`).
- [x] **Acceptance:** open `http://<LAN-IP>:$API_PORT/health` in the phone's browser (or a one-line fetch in Expo) and see the `{ status: "ok" }` response on the device.

## 4. Data model & migrations
- Migration `0000_init`: **only** the extension bootstrap (`citext`, `pgcrypto`) and the empty `enums.ts` wiring so `drizzle-kit` is proven to emit `CREATE TYPE` when enums are added later. No domain tables (those land per-milestone from M2).
- Drizzle config: `schema` glob **must include `enums.ts`** (recap §5 — otherwise pgEnums aren't emitted as `CREATE TYPE`).

## 5. API endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness ping; returns `{ status: "ok" }`. Proves device↔backend reachability over LAN/Tailscale. |

(Full health/healthz/DB-verify/error-envelope surface is M1.)

## 6. Mobile (Expo Go, Android)
- No app screens yet. Only a throwaway verification: a phone-browser hit (or a minimal Expo fetch) against `http://<LAN-IP>:$API_PORT/health` to prove networking. Full Expo shell is **M5**.

## 7. Tests (live-stack)
- `docker compose up` brings up all three services and the `minio-setup` one-shot creates all three buckets (assert buckets exist via `mc ls` / S3 `ListBuckets`).
- API boots and `GET /health` returns 200 against the running compose stack.
- `bun test` runs green in `packages/contracts` (even if only a trivial enum/schema smoke test) — proves the test runner + TS-source resolution work.
- Drizzle migrate against the compose Postgres succeeds and the `citext` + `pgcrypto` extensions are present (`SELECT extname FROM pg_extension`).
- Drizzle single-copy check: `bun pm ls drizzle-orm` (or equivalent) resolves exactly **one** physical copy across `contracts` + `services/api`.

## 8. Acceptance criteria
- `docker compose up` yields healthy Postgres 16 (citext), Redis 7, MinIO with `raw`/`montages`/`thumbnails` created.
- `bun run dev` boots the API; host `GET /health` → 200.
- Migration `0000_init` applied; `citext` + `pgcrypto` extensions exist in the DB.
- Exactly one physical `drizzle-orm` is resolved across packages (kysely devDep + dedupe lever in place).
- `fixtures/sample-media/` exists with its README.
- **Android device check (required):** a real Android device on the same LAN/Tailscale opens `http://<LAN-IP>:$API_PORT/health` and sees the `{ status: "ok" }` response. MinIO is independently reachable from the device at `http://<LAN-IP>:9000/minio/health/live`.

## 9. Dependencies & prerequisites
- Bun installed; Docker + docker-compose available on the WSL box.
- A real Android device with Expo Go (or just a browser) on the same LAN or Tailscale tailnet as the dev machine.
- WSL2 networking configured (mirrored mode or portproxy) so the phone reaches WSL-hosted services via the Windows host.
- Libs: `fastify`, `drizzle-orm`, `drizzle-kit`, `kysely` (devDep, dedupe lever), `zod`, ESLint 9 + Prettier, `postgres` (postgres.js driver).

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md)
- **§7 / §8.8 — reconcile to ONE infra story.** v1 shipped an unused `docker-compose.dev.yml` alongside a no-Docker `scripts/dev.sh` with a `:5432` vs `:5433` port divergence foot-gun. Here: a single canonical `docker-compose.yml`, no parallel host-based path, env bootstrap baked into the repo.
- **§5 / §8.1 — pin one physical drizzle-orm before auth.** The better-auth→kysely dual-copy `PgColumn` type clash cost real debugging. Add the `kysely` devDep + `.npmrc dedupe-peer-dependents=false` now (M0), before Better Auth (M2).
- **§5 / §8.8 — device networking is a 3-part unit:** `0.0.0.0` bind + LAN-IP env (`EXPO_PUBLIC_API_URL`) + WSL2 mirrored networking. v1 discovered the loopback-unreachable problem only on real hardware; prove it day one.
- **§5 — presign host = connect host.** Bake the principle in now (env points at the LAN/Tailscale host) so M4's SigV4 presigns are device-usable; MinIO binds `0.0.0.0` and is reachable from the phone.
- **§5 / §9 — drizzle migration gotchas:** include `enums.ts` in the `schema` glob; hand-prepend `CREATE EXTENSION citext/pgcrypto` in the first migration.

## 11. Open decisions / flags
- **Compose vs no-Docker on the actual WSL box.** Recap notes the WSL box had no Docker/no-sudo in v1. Locked decision (README) is **Docker compose**; *flag* — if Docker is unavailable on this machine, the env-bootstrap must still bring up the same three services bound `0.0.0.0`, but the README/compose stay the single source of truth. **Default: Docker compose.**
- **Tailscale vs raw LAN.** Either works; Tailscale is more robust across networks. **Default: whichever the dev machine + phone already share; document both in `RUNNING.md`.**
- **`packages/db` vs folding DB into `packages/contracts`.** v1 folded it into `contracts/src/db/`. **Default: keep DB inside `packages/contracts` (contracts-as-spine), no separate `packages/db`.**
