# Running twenty4 locally

The stack is: **Postgres + Redis + MinIO** (local infra) → **API** (`services/api`, :4000) + **worker** (`services/worker`, BullMQ render/validate/sweeps) → a **client** (the Expo app or the admin console). On this machine the infra + toolchain are already provisioned (`~/.twenty4-dev-env.sh` sets Node 22, the embedded Postgres on :5433, MinIO/ffmpeg in `~/bin`, and all env vars).

> Always `source ~/.twenty4-dev-env.sh` in a shell before running anything by hand. The `scripts/dev.sh` script does this for you.

---

## 1. Start the backend (required for everything)

```bash
cd ~/projects/twenty4
bash scripts/dev.sh
```

This boots Postgres + Redis + MinIO (starting any that are down), applies migrations, then runs the **API on :4000** and the **worker**. Leave it running; `Ctrl+C` stops the API + worker. Check it: open <http://127.0.0.1:4000/health> (should show `db/redis/storage: true`).

To exercise the **admin** console you must be an admin — start with your email allow-listed:

```bash
ADMIN_EMAILS=you@example.com bash scripts/dev.sh
```

---

## 2. Try the app — easiest path: **the browser** (no phone needed)

In a second terminal:

```bash
cd ~/projects/twenty4/apps/mobile
pnpm web        # = expo start --web ; opens http://localhost:8081
```

The app runs in your browser against the local API (default `EXPO_PUBLIC_API_URL=http://127.0.0.1:4000`). You can do the whole loop: **sign up** (it's email-OTP — in dev the code is shown at `http://127.0.0.1:4000/auth/dev/last-otp?identifier=<your-email>`, or printed in the API log), create a group, add photos (web uses a foreground upload fallback), **generate a montage** (the worker renders it in ~20–30s), review, publish, and see it in the feed with reactions/comments.

Native-only screens (live camera, real-video full-screen player, background upload, push, save-to-gallery) are stubbed on web — those need the device build (§4).

### UI-only browsing without a backend
Set mock flags to see screens with seeded data and no API:
`EXPO_PUBLIC_MOCK_TODAY=items EXPO_PUBLIC_MOCK_FEED=1 pnpm web`

---

## 3. Admin / ops console (browser)

```bash
cd ~/projects/twenty4/apps/admin
pnpm dev        # Vite → http://localhost:5173  (VITE_API_URL defaults to :4000)
```

Sign in with the email you put in `ADMIN_EMAILS` (step 1). Moderate reports, suspend/ban users, remove content, view ops (queue/storage/metrics).

---

## 4. On your Android phone (full native experience)

The app uses custom native modules (camera, `react-native-background-upload`, etc.), so **Expo Go won't work — you need a dev client**.

1. **Build + install the dev client** (needs Android Studio / SDK + a phone with USB debugging, or an emulator):
   ```bash
   cd ~/projects/twenty4/apps/mobile
   pnpm android        # = expo run:android  (builds, installs, starts Metro)
   ```
   (Or use EAS Build for a cloud APK, then `pnpm start` and scan the QR with the dev client.)

2. **Point the app at this machine's API.** The phone can't reach `127.0.0.1` — it needs your machine's LAN IP:
   ```bash
   EXPO_PUBLIC_API_URL=http://<your-machine-LAN-ip>:4000 pnpm start
   ```
   The API already listens on `0.0.0.0:4000` (via `scripts/dev.sh`).

3. **WSL2 networking note:** on WSL2 the phone hits the **Windows host** IP, which must forward to WSL. Easiest fix — enable mirrored networking in `C:\Users\<you>\.wslconfig`:
   ```ini
   [wsl2]
   networkingMode=mirrored
   ```
   then `wsl --shutdown` and restart. (Alternatively add a `netsh interface portproxy` rule on Windows for port 4000 → the WSL IP.)

---

## 5. Run the tests

```bash
cd ~/projects/twenty4
pnpm -r exec vitest run        # contracts + api + worker against the live infra
# or per package, e.g.:  (cd services/worker && pnpm exec vitest run)   # incl. the §6 deletion + §7.5 render gates
```

If media/montage tests time out, MinIO dropped under load — re-run `scripts/dev.sh` (it restarts it).

---

## Ports
| | |
|---|---|
| API | http://127.0.0.1:4000 (`/health`, `/healthz`) |
| Mobile (web) | http://localhost:8081 |
| Admin | http://localhost:5173 |
| Postgres | 127.0.0.1:**5433** (db `twenty4`) |
| Redis | 127.0.0.1:6379 |
| MinIO | http://127.0.0.1:9000 (console :9001, minioadmin/minioadmin) |
