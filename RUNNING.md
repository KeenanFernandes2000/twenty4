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
