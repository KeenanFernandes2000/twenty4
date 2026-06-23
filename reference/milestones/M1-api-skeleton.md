# M1 — API Skeleton
> Spec phase: P1 · Depends on: M0 (monorepo + Docker infra + device↔backend ping) · Branch commit: one squashed commit on `rebuild/v2` ("M1: fastify-on-bun base — health, db-verify, error envelope, content-type, CORS")

## 1. Goal
A correct, boring Fastify-on-Bun base that won't surprise us later: liveness + readiness, DB-verify-on-boot (fail fast), Drizzle wired, fail-fast Zod env (with a prod-secret guard), a global error envelope `{ error: { code, status, message } }` backed by a contracts error taxonomy, the root `'*'` content-type parser so RN/Expo bodies never spuriously 415, an explicit CORS method list (incl. PATCH/PUT/DELETE/OPTIONS) verified by a **real preflight test**, request logging, graceful shutdown, and a registered-but-disabled rate-limit scaffold.

## 2. Scope
- **In scope:**
  - Health: `GET /health` (liveness) + `GET /healthz` (readiness incl. DB).
  - **DB connectivity verified on boot** — a `SELECT 1` that fails the process start if Postgres is unreachable.
  - Drizzle wired into the API (postgres.js driver, single physical `drizzle-orm` from M0).
  - **Fail-fast Zod env** parsing at startup, with a **prod-secret guard** (refuse to boot in prod with dev/placeholder secrets).
  - **Global error handler** → `{ error: { code, status, message } }` envelope; **error taxonomy** (codes + statuses) in `packages/contracts`.
  - **Root `'*'` content-type parser**: parse-as-string → try `JSON.parse` → fall back to raw, so missing/non-JSON Content-Type bodies reach the route (clean 401/422, never spurious 415).
  - **Explicit CORS** method list incl. `GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS`; allowed headers incl. `content-type`, `authorization`.
  - `trustProxy` enabled (for correct client IP behind the dev proxy / Tailscale).
  - **Request logging** (pino, with method/path/status/latency; redact auth headers).
  - **Graceful shutdown** on `SIGINT`/`SIGTERM`: stop accepting connections, then close BullMQ queues, Redis, and the DB pool.
  - **Rate-limit scaffold**: `@fastify/rate-limit` registered **global-disabled**, opt-in per-route later.
- **Explicitly out of scope (later milestone owns it):**
  - Better Auth, sessions, `requireSession` guard, OTP → **M2**.
  - Domain tables/routes (groups, media, montage, feed) → **M3+**.
  - Actual rate-limit *enforcement* on OTP/upload routes → **M2/M4** (scaffold only here).
  - BullMQ worker job logic → **M7** (we only ensure queue handles close cleanly on shutdown; no jobs yet).
  - Storage presign / S3 client → **M4**.

## 3. Tasks (ordered checklist)
- [ ] `packages/contracts`: add `src/errors/` — an **error taxonomy** (e.g. `UNAUTHORIZED`/401, `FORBIDDEN`/403, `NOT_FOUND`/404, `VALIDATION_FAILED`/422, `RATE_LIMITED`/429, `INTERNAL`/500, plus a base `AppError` carrying `{ code, status, message }`). Export Zod-typed error envelope shape `{ error: { code, status, message } }`.
- [ ] `packages/contracts`: add `src/env/` — a Zod env schema (DB/Redis/S3/host/port/secrets) used by every service.
- [ ] `services/api`: at startup, **parse env via the contracts Zod schema; exit non-zero on failure**. Add a **prod-secret guard**: if `NODE_ENV=production` and any secret matches a known dev/placeholder value (or is empty), throw before listen.
- [ ] `services/api`: create the Drizzle DB client (postgres.js) from `DATABASE_URL`.
- [ ] `services/api`: **DB-verify-on-boot** — run `SELECT 1` before `listen`; on failure, log + `process.exit(1)` (fail fast).
- [ ] `services/api`: register the **root `'*'` content-type parser** (parse-as-string → `try { JSON.parse } catch { raw }`). Ensure any future encapsulated auth `'*'` parser (M2 Better Auth) is unaffected.
- [ ] `services/api`: register **`@fastify/cors`** with an **explicit `methods` array** (`GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS`) + `allowedHeaders` (`content-type`, `authorization`), origin policy appropriate for dev (reflect/allow LAN origins).
- [ ] `services/api`: enable `trustProxy: true`.
- [ ] `services/api`: configure **pino request logging** (method, path, status, response time; redact `authorization`/`cookie`).
- [ ] `services/api`: register a **global error handler** that maps `AppError` → its `{ code, status }`, maps Zod errors → `VALIDATION_FAILED`/422, and unknown errors → `INTERNAL`/500 (no leakage), all in the `{ error: { code, status, message } }` envelope.
- [ ] `services/api`: routes `GET /health` (process up) and `GET /healthz` (DB reachable → 200, else 503).
- [ ] `services/api`: register **`@fastify/rate-limit` global-disabled** (`global: false`), so routes can opt in later.
- [ ] `services/api`: **graceful shutdown** hooks — on `SIGINT`/`SIGTERM`, `app.close()` then close (placeholder) BullMQ queues, Redis client, and the postgres.js pool; idempotent; bounded timeout.
- [ ] Write the live-stack tests in §7 (including the **real CORS preflight** test).
- [ ] Run the suite green against the M0 Docker compose stack.

## 4. Data model & migrations
- None (no new domain tables). The M0 `0000_init` extension bootstrap is the only migration. M1 adds the error taxonomy + env schema as **TS contracts**, not DB objects.

## 5. API endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness — process is up. |
| GET | `/healthz` | none | Readiness — `SELECT 1` succeeds (200) else 503. |

(All responses on error use the `{ error: { code, status, message } }` envelope.)

## 6. Mobile (Expo Go, Android)
- None. No mobile code this milestone. (The M0 device ping already proved reachability; the Expo shell is M5.) The content-type + CORS fixes here are precisely what unblock the RN client later.

## 7. Tests (live-stack)
Run against the real M0 Postgres/Redis/MinIO compose stack. **Use the real HTTP server (`fastify.listen` / a real socket) for the CORS test — `app.inject` does not issue a true preflight.**
- **Content-type regression:** `POST` a body with **missing / `application/octet-stream` / non-JSON** Content-Type → asserts the request reaches the route and returns a clean `401`/`422` in the error envelope, **never `415`**. (This is the v1 §5 bug.)
- **Real CORS preflight:** issue an actual `OPTIONS` preflight with `Origin` + `Access-Control-Request-Method: PATCH` (also `PUT`, `DELETE`) over a real socket → asserts the `Access-Control-Allow-Methods` response includes PATCH/PUT/DELETE/OPTIONS and the preflight succeeds. (Inject-based tests missed this in v1 — the CORS bug slipped through.)
- **Health:** `GET /health` → 200 `{ status: "ok" }`.
- **Readiness / DB-verify:** `GET /healthz` → 200 when DB is up; and a boot-time check that the process **exits non-zero** when `DATABASE_URL` points at an unreachable DB (fail-fast assertion).
- **Error envelope shape:** an unknown-route / forced error returns `{ error: { code, status, message } }` (no stack/internal leakage); a Zod-invalid request returns `VALIDATION_FAILED`/422 in the envelope.
- **Env fail-fast / prod-secret guard:** booting with a missing required env var (or a placeholder secret under `NODE_ENV=production`) fails startup.

## 8. Acceptance criteria
- `GET /health` → 200; `GET /healthz` → 200 (DB up) / 503 (DB down).
- API **refuses to boot** when the DB is unreachable or required env is missing; **refuses to boot** in prod with placeholder secrets.
- Every error response is the `{ error: { code, status, message } }` envelope, backed by the contracts taxonomy.
- A non-JSON / missing-Content-Type POST body **does not 415** — it reaches the route.
- A **real** `OPTIONS` preflight for PATCH/PUT/DELETE succeeds with the correct `Access-Control-Allow-Methods`.
- Graceful shutdown closes DB/Redis/queue handles cleanly on `SIGINT`/`SIGTERM`.
- Rate-limit plugin is registered but globally disabled.
- Full live-stack suite green.
- **Android device check (required):** from the Android device (browser or a one-line Expo fetch over LAN/Tailscale), `GET /healthz` returns 200, **and** a `POST` to a test/echo route with **no `Content-Type` header** returns a clean (non-415) envelope response — proving the RN-shaped request path works end-to-end on real hardware.

## 9. Dependencies & prerequisites
- M0 complete: Bun monorepo, Docker compose stack (Postgres 16/Redis 7/MinIO), single physical `drizzle-orm`, device↔backend networking proven.
- Libs: `fastify`, `@fastify/cors`, `@fastify/rate-limit`, `pino`, `zod`, `drizzle-orm`, `postgres` (postgres.js). (`ioredis`/`bullmq` may be present for the shutdown hooks even though no jobs run yet.)

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md)
- **§5 — content-type 415.** Fastify's default parser only handles `application/json` + `text/plain`; RN/Expo fetch often sends a body with missing/`application/octet-stream` Content-Type → spurious 415 before the route runs. Fix: root `'*'` parse-as-string→try-JSON→raw parser, with a regression test. (§8.5)
- **§5 — CORS preflight blind spot.** `@fastify/cors` v11 defaults methods to GET/HEAD/POST → all PATCH/PUT/DELETE preflights rejected; it **slipped through because inject-based tests never issue a real preflight**. Fix: explicit method list **and** a real-socket preflight test. (§8.5)
- **§5 / §8 — fail fast.** DB-verify-on-boot and Zod env fail-fast catch infra/config errors at startup, not mid-request.
- **§8 — front-door HTTP hardening for RN clients is two one-time fixes** (content-type fallback + explicit CORS methods); do both here so the M5 mobile client never hits mysterious 415/preflight failures.

## 11. Open decisions / flags
- **CORS origin policy in dev.** Reflect/allow LAN + Tailscale origins for local device testing; tighten to an allow-list at launch (M15). **Default: permissive-in-dev, explicit method list always.**
- **`/healthz` depth.** Could also check Redis/MinIO, but per fail-fast scope this milestone gates only on DB. **Default: DB-only readiness now; extend when those clients are wired (Redis M7, S3 M4).**
- **Rate-limit store.** `@fastify/rate-limit` can use in-memory or Redis. Scaffold registered global-disabled; **default: Redis-backed when enforcement turns on at M2 (OTP) / M4 (upload).**
- **trustProxy scope.** `true` is fine for the single-hop dev/Tailscale setup; revisit (CIDR allow-list) for prod. **Default: `true` in dev, harden at M15.**
