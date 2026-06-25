# Running twenty4 locally (+ device networking)

Single canonical infra story: **Docker compose**. One file (`docker-compose.yml`),
one `.env`. No parallel host-based path.

## TL;DR — bring everything up

```bash
cp .env.example .env            # values match docker-compose.yml defaults
docker compose up -d            # postgres + redis + minio + minio-setup + mailpit
bun install                     # workspaces; single physical drizzle-orm
bun run db:migrate              # apply 0000_init (citext + pgcrypto + enum scaffolding)
bun run dev                     # start the API (binds 0.0.0.0:3000)

# from the host:
curl http://localhost:3000/health        # -> {"status":"ok"}
# from a real device (see device checklist below):
curl http://100.98.100.117:3000/health   # Tailscale IP example
```

Service endpoints (compose):

| Service  | Host port(s)        | Notes |
|----------|---------------------|-------|
| Postgres | **5433** (→ container 5432) | db/user/pass = `twenty4`/`twenty4`/`twenty4`; healthcheck via `pg_isready`. Host port is 5433 (not 5432) because under **Docker Desktop + WSL2** a Windows-side Postgres shadows `localhost:5432` — a host-run API would silently hit the wrong DB. |
| Redis    | **6380** (→ container 6379) | host port 6380 (not 6379) — a native/Windows Redis shadows `localhost:6379`. |
| MinIO    | 9000 (S3), 9001 (UI)| buckets `raw`, `montages`, `thumbnails` (created by `minio-setup`); user/pass `minioadmin`/`minioadmin` |
| Mailpit  | 1025 (SMTP), 8025 (UI)| email capture for M2 email-OTP dev transport |

---

## Device-networking checklist (run as ONE unit)

A real Android device (Expo Go or just its browser) on the same LAN/Tailscale net
must reach the WSL-hosted services. v1 only discovered the loopback-unreachable
problem on real hardware — prove it day one. All four parts must be right at once:

1. **API binds `0.0.0.0`, not loopback.** `API_HOST=0.0.0.0` (default). A
   `127.0.0.1` bind is unreachable from the phone.

2. **`EXPO_PUBLIC_API_URL` = the machine's LAN/Tailscale IP**, never `127.0.0.1`.
   - Tailscale: `http://100.98.100.117:3000`
   - LAN: `http://192.168.3.101:3000`
   (Tailscale is more robust across networks; use whichever the dev machine and
   phone already share.)

3. **WSL2 reachability.** The phone hits the **Windows host**, not WSL directly
   (WSL2 double-NAT). Pick ONE:
   - **Preferred — mirrored networking.** In `%UserProfile%\.wslconfig` on Windows:
     ```ini
     [wsl2]
     networkingMode=mirrored
     ```
     then `wsl --shutdown` (from Windows) and reopen WSL. WSL now shares the
     Windows host's interfaces, so the LAN/Tailscale IP reaches WSL services.
   - **Fallback — `netsh portproxy`** (run in an elevated Windows PowerShell;
     replace `<WSL_IP>` from `wsl hostname -I`):
     ```powershell
     netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=<WSL_IP>
     netsh interface portproxy add v4tov4 listenport=9000 listenaddress=0.0.0.0 connectport=9000 connectaddress=<WSL_IP>
     ```
     (Add the same for any other port the device must reach. Remove with
     `netsh interface portproxy delete v4tov4 listenport=3000 listenaddress=0.0.0.0`.)

4. **MinIO bound `0.0.0.0` and reachable from the phone.** It binds `0.0.0.0` by
   default. Verify from the device browser:
   `http://100.98.100.117:9000/minio/health/live` (or the LAN IP). This matters
   because **presign host = connect host** (M4 SigV4 presigns sign the Host header;
   a loopback-signed URL is unusable from the device).

### Acceptance (the M0 device check)
Open `http://<LAN-or-Tailscale-IP>:3000/health` in the **phone's browser** and
see `{ "status": "ok" }`. Independently confirm
`http://<LAN-or-Tailscale-IP>:9000/minio/health/live` returns healthy from the device.

---

## Useful one-liners

```bash
# verify buckets exist
docker compose run --rm --no-deps --entrypoint sh minio-setup -c \
  "mc alias set local http://minio:9000 minioadmin minioadmin >/dev/null && mc ls local"

# verify extensions
docker compose exec postgres psql -U twenty4 -d twenty4 -c "SELECT extname FROM pg_extension;"

# tear everything down (and wipe volumes)
docker compose down -v
```

---

## Verifying the build (M0–M4 smoke test)

One self-contained script proves milestones **M0–M4** work end-to-end against a
**running** stack:

```bash
bun scripts/smoke.ts [--api <url>]      # default --api http://localhost:3000
```

It creates its own throwaway users / group / media via the real API, exercises
health + error envelope (M0/M1), dev-OTP auth (M2), groups/invites/membership
(M3) and the full storage round-trip — init → presigned PUT → complete →
validation → signed download + byte-compare (M4) — then best-effort deletes the
group + media it created. It prints a ✅/❌ line per step grouped by milestone and
exits non-zero if anything fails:

```
M0–M4: 22/22 checks passed ✅
```

**Must be up first** (the script does NOT start them):

```bash
docker compose up -d                    # postgres + redis + minio
bun services/api/src/index.ts           # API on :3000
bun services/worker/src/index.ts        # worker — REQUIRED for M4 validation
```

If the worker isn't running, M0–M3 still report; M4 fails with a clear hint that
media validation stayed `pending`.

**From the phone** (Termux + Bun) point it at the LAN/Tailscale IP — same command,
just change `--api` (no fixtures or native modules needed):

```bash
bun scripts/smoke.ts --api http://100.98.100.117:3000
```

Notes:
- Each run uses **fresh phone identifiers** (auto-incrementing counter in the OS
  temp dir). Pin a fixed base with `--seed <n>` if you need determinism. Account
  deletion is a soft-delete, so identifiers are never reused.
- Running the smoke many times within ~15 min can trip the per-IP OTP cap
  (`OTP_MAX_PER_IP`, default 20 / `OTP_WINDOW_SEC` 900s) — the script reports a
  clear 429 message; wait for the window or raise the cap in `.env`.
- Presigned URLs are signed with `S3_PUBLIC_ENDPOINT`; the script asserts the
  host is **not** localhost, so that must be set to the reachable host.

---

## Running the mobile app (M5)

The Expo Go app (`apps/mobile`, Android-first). Boots, signs in via phone+email
OTP, creates/joins groups — all wired to the LAN/Tailscale backend.

**Prerequisites** — the stack must be up (the app is a client, it starts nothing):

```bash
docker compose up -d                    # postgres + redis + minio + mailpit
bun services/api/src/index.ts           # API on :3000 (binds 0.0.0.0)
bun services/worker/src/index.ts        # worker
```

The **device-networking checklist above applies** — API on `0.0.0.0`, WSL2
`networkingMode=mirrored`, reachable via the LAN/Tailscale IP, never `127.0.0.1`.
Prove `http://<LAN-or-Tailscale-IP>:3000/health` from the phone's browser first.

**Set the API URL** — Expo loads `.env` from the **app dir**, NOT the repo root:

```bash
cp apps/mobile/.env.example apps/mobile/.env
# set EXPO_PUBLIC_API_URL to the SAME LAN/Tailscale IP as root .env, e.g.:
#   EXPO_PUBLIC_API_URL=http://100.98.100.117:3000
```

(`apps/mobile/.env` is gitignored; `.env.example` is committed.)

**Launch** — from the repo root:

```bash
bun run dev:mobile                      # Expo dev server (expo start)
```

Open in **Expo Go** on the phone (scan the QR). Android-first. Sign in with the
**dev OTP** — the verify screen auto-fills the code in dev; for email OTP, read it
from Mailpit at `http://localhost:8025`.

### Verify the mobile build (M5 web e2e)

A Playwright suite drives the **web build** through the full client flow against
the live API — the headless proxy for the on-device acceptance check:

```bash
bun run test:e2e:mobile                 # needs the stack up + Playwright chromium
```

It runs sign-in (phone + email) → profile setup → groups → invite/join across
two browser contexts (membership asserted on both rosters) plus cold deep-link
join, then captures Ember-theme screenshots under `apps/mobile/e2e/screenshots/`
(gitignored). Caveats (per `apps/mobile/e2e/README.md`):

- Repeated runs can trip the per-IP OTP cap (`OTP_MAX_PER_IP`, 20 / 15 min) —
  flush `otp:*` keys on redis (port **6380**) between runs.
- Email OTP is fetched from **Mailpit** (`GET /auth/dev/last-otp` is phone-only).

> **The M5 acceptance gate is on-device interactive testing** (Expo Go on a real
> Android phone) — the web e2e is the proxy, not the gate.

---

## Capture & today bucket (M6)

Same app, same stack (docker + API + **worker** — the worker validates uploads).
M6 adds in-app camera capture, gallery import, per-item upload progress, and
today's bucket. No new env — it's a pure client of M4's media endpoints.

**Reach the Today screen:** from the **Groups home**, tap **"Today's captures →"**.

**Capture in-app:** on Today, open the **camera** (§9.1 screen). Controls: shutter,
photo/video **mode** toggle, **front/back** switch, **flash** toggle. Take a photo
or (native only — web is photo-only) **record/stop** a video. Captured items show
in the thumbnail strip and enqueue for upload.

**Import from the gallery:** **Import** opens `expo-image-picker` multi-select
(photos + videos) — pick from `fixtures/sample-media/`; selected assets enqueue.

**Watch upload progress:** each queued item streams to storage with a **0..1
progress bar** and queued/failed badges. **Cancel** an in-flight upload, **retry**
a failed one, or **remove** an item (each best-effort frees the server row it
reserved). Up to **3** upload concurrently.

**Land in today's bucket:** completed items appear in **today's list** (a 3s poll
runs only while an item is `validating`, then self-stops). A **readiness banner**
("enough content to generate?") reflects the count and gates the M7 generate CTA.

> **Known behavior (by design):** imported photos whose **EXIF proves they're
> older** than today's 4am→4am window are marked **"Rejected"** (anti-backfill —
> the server's freshness gate). **In-app captures and today's photos validate**
> (imports declare `capturedAt = now`; only forgeable old EXIF is rejected).

### Verify the capture build (M6 web e2e)

The same Playwright command now covers **M5 + M6** — **15 flows** (the 8 M5 auth/
group flows plus **7 new M6 capture/import/upload/today** flows):

```bash
bun run test:e2e:mobile                 # needs the stack up (incl. worker) + chromium
```

It drives the web build: import from `fixtures/sample-media/` → foreground upload
with progress → item lands in `GET /media/today`; plus cancel (incl.
cancel-before-send), retry, remove, and the readiness-threshold flip. The native
`expo-file-system` streaming branch is **device-verified manually** (not headless).

> **The M6 acceptance gate is on-device interactive testing** (capture a video AND
> import a photo in Expo Go, both upload with visible progress and land in today's
> bucket) — the web e2e is the proxy, not the gate.
