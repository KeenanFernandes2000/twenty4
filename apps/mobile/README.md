# @twenty4/mobile

Placeholder workspace. The full Expo shell (Expo Go, Android-first) is scaffolded
in **M5** — it is intentionally NOT scaffolded at M0.

At M0 the only mobile concern is proving the device can reach the backend:
open `http://<LAN-or-Tailscale-IP>:3000/health` in the phone's browser and see
`{ "status": "ok" }`. See `RUNNING.md` at the repo root for the full
device-networking checklist.

`EXPO_PUBLIC_API_URL` must point at the machine's LAN/Tailscale IP, never
`127.0.0.1` (loopback is unreachable from the device).
