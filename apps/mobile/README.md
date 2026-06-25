# @twenty4/mobile

The twenty4 Expo app (Expo Go, Android-first, JS-only libs). Shipped in **M5** —
a working Expo Go app: full OTP auth (phone+email) → profile setup → groups +
invite/join, all on the re-implemented Ember dark theme.

## Run

Set the API URL first (Expo loads `.env` from **this app dir**, not the repo root):

```bash
cp apps/mobile/.env.example apps/mobile/.env   # set EXPO_PUBLIC_API_URL to the LAN/Tailscale IP
```

Then from the **repo root** (scripts live there per repo convention):

```bash
bun run dev:mobile   # expo start  (scan QR with Expo Go on Android)
bun run web:mobile   # expo start --web  (headless QA path)
```

Stack must be up first (docker + API + worker). See `RUNNING.md` for the
device-networking checklist and the full M5 run/verify story.

## Layout

- `src/app/` — expo-router routes. `_layout.tsx` is the root layout (fonts +
  providers, holds splash until ready) and hosts `AuthGate` (segment-based; routes
  `(auth)` vs `(app)`, global `SuspendedScreen`, passes through `invites/[code]` +
  `dev-gallery`). `(auth)/` = welcome → sign-in → verify → profile-setup → legal.
  `(app)/` = groups list / create / detail / members / invite. `invites/[code].tsx`
  = deep-link join (cold-start + logged-out resume).
- `src/theme/` — Ember dark-theme tokens (colors, Nunito type scale, spacing,
  radii, shadows, per-platform `shadow()`) + `ThemeProvider`/`useTheme`.
- `src/ui/` — primitives on the theme: Screen, Text, Button (ember-gradient pill),
  Input, OTPInput, Card, Avatar, Spinner, Toast (ToastProvider/useToast).
- `src/stores/` — zustand `authStore` (token + UserDTO + 5-state machine:
  loading/unauthenticated/needs-profile/suspended/authenticated); platform-split
  secure storage (`secureStore.native.ts` expo-secure-store / `secureStore.web.ts`
  localStorage, key `twenty4.session_token`).
- `src/lib/` — react-query `queryClient` + `queryKeys`; typed `@twenty4/api-client`
  singleton (`api.ts`) with Bearer injection + `onUnauthorized → clear()`.
- `metro.config.js` — Bun-monorepo wiring (watches the repo root, resolves the
  sibling workspace packages `@twenty4/contracts` / `@twenty4/api-client` as raw
  TS source, follows Bun's symlinks).
- `app.json` — name `twenty4`, scheme `twenty4` (deep links `twenty4://...`),
  Android package `com.twenty4.app`, dark UI.

## Fonts

Loaded in `src/app/_layout.tsx` via `expo-google-fonts`:

- **Nunito** (UI/body): `400/600/700/800/900`
- **JetBrains Mono** (numeric)

## Networking

`EXPO_PUBLIC_API_URL` (in `apps/mobile/.env`) must point at the machine's
LAN/Tailscale IP, never `127.0.0.1` (loopback is unreachable from the device).
See `RUNNING.md` at the repo root for the device-networking checklist.

## e2e

```bash
bun run test:e2e:mobile   # Playwright (web build) — needs the stack up + chromium
```

Drives the web build through sign-in → groups → invite/join (6 flows incl.
cross-context invite+join and cold deep-link). Captures Ember-theme screenshots
under `e2e/screenshots/`. Gotchas (OTP per-IP cap, email OTP via Mailpit) in
`e2e/README.md`.
