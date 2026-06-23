# M5 — Mobile shell

> Spec phase: P1 · Depends on: M0 (Bun monorepo + Android↔backend networking), M1 (API skeleton + error envelope/CORS), M2 (auth: phone+email OTP, sessions, guards), M3 (groups + invite/join + membership authz) · Branch commit: one commit on `rebuild/v2` (merged only after the Android acceptance check passes)

## 1. Goal

On a real Android phone, the Expo Go app boots, a user signs in end-to-end with **phone *and* email OTP** (welcome → sign-in → verify → profile setup → legal), and from there can **create a group and join a group via code/deep-link**, all wired to the LAN/Tailscale backend through a typed API client consuming `packages/contracts`. The whole app wears the re-implemented **Ember dark theme** (tokens from `reference/Spool.html`).

## 2. Scope

- **In scope:**
  - Expo (Expo Go, Android-first) app boots on a real device; `expo-router` file-based navigation.
  - Typed `api-client` package (or `apps/mobile/src/lib/api`) consuming Zod DTOs + error taxonomy from `packages/contracts`; single source of base URL.
  - `EXPO_PUBLIC_API_URL` env (LAN/Tailscale IP, not `127.0.0.1`); documented per-device.
  - **Ember design system re-implemented in RN** from `reference/Spool.html`: dark theme colors/fonts/spacing/radii tokens as a `ThemeProvider`, plus a small `ui` primitive library (Button, Text, Input, OTPInput, Screen, Card, Avatar, Spinner, Toast).
  - **Auth screens:** Welcome (1.1), Sign-in (phone + email; 1.2), Verify OTP (1.3), Profile setup (1.4 — display name, username, photo placeholder), Legal reader (1.7).
  - **State:** zustand `authStore`; token persisted in `expo-secure-store` on native, `localStorage` on web (platform-split).
  - **react-query** provider + key factories (auth/session, groups list, group detail, members, invite preview).
  - **AuthGate:** segment-based navigation guard via `expo-router` route groups — `(auth)` vs `(app)`; `account_status=suspended` → `SuspendedScreen` (global state §9 "Suspended").
  - **Group screens:** create (4.x), join via code + **deep-link** (`/invites/{code}`), `[id]` detail, members (list + owner-remove/leave), invite/share (generate code, share sheet).
  - Global states wired where they gate the above flows: Loading skeleton, Error+retry, Offline, Toasts/rollover.
- **Explicitly out of scope (owner milestone):**
  - In-app camera, gallery import, today bucket, upload UI → **M6**.
  - Montage generate/review/publish, themes, music → **M7**.
  - Feed, reactions, comments → **M8**.
  - 24h expiry/deletion UI surfaces → **M9**.
  - Push notifications & reminders → **M11**.
  - Contacts discovery, notification priming screens → deferred (P2 onboarding; stub the routes if linked).
  - Social auth (Apple/Google) → **M14**.
  - Background/resumable upload, dev-client → **M13**. iOS → **M14**.

## 3. Tasks (ordered checklist)

- [ ] Scaffold `apps/mobile` Expo app (Expo Go target, Android-first); confirm it opens in Expo Go on a real device over LAN.
- [ ] Run `npx expo install --fix` immediately and pin the resolved versions — **do not hand-write RN/Expo versions** (PLAN.md's RN 0.81 guess was wrong; reality was 0.85.3).
- [ ] Add `expo-router`; set up route groups `(auth)` and `(app)` with a root layout that renders `AuthGate`.
- [ ] Wire `react-query` `QueryClientProvider` + a typed `queryKeys` factory module.
- [ ] Build the typed API client: `fetch` wrapper that injects `Authorization: Bearer <token>`, parses `{ error: { code, status, message } }` into a typed `ApiError`, and types request/response against `packages/contracts` Zod DTOs. Base URL from `EXPO_PUBLIC_API_URL`.
- [ ] Re-implement Ember tokens from `reference/Spool.html` (dark theme: bg/surface/border, accent/ember, text primary/secondary/muted, success/danger; font family + sizes/weights; spacing scale; radii) as a typed `theme` object + `ThemeProvider`.
- [ ] Build the `ui` primitives on the theme: `Screen` (safe-area + bg), `Text`, `Button` (variants), `Input`, `OTPInput`, `Card`, `Avatar`, `Spinner`, `Toast`/toast host.
- [ ] Implement `authStore` (zustand): `{ token, user, status, hydrate(), setSession(), clear() }`; persist token via a platform-split `secureStore.native.ts` (expo-secure-store) / `secureStore.web.ts` (localStorage).
- [ ] On launch, hydrate token from secure store, then `GET` session/me to populate `user` + `account_status`.
- [ ] **Welcome (1.1):** entry CTA → Sign-in.
- [ ] **Sign-in (1.2):** toggle phone / email; `POST /auth/start` with the chosen identifier.
- [ ] **Verify OTP (1.3):** `OTPInput`; `POST /auth/verify`; on success store session; new user → Profile setup, existing → app.
- [ ] **Profile setup (1.4):** `POST /users` (display name, username, optional photo placeholder); handle username-taken error from the taxonomy.
- [ ] **Legal reader (1.7):** render `GET /legal/privacy` + `GET /legal/terms` (stub content acceptable for P1).
- [ ] **AuthGate:** redirect unauthenticated → `(auth)`, authenticated → `(app)`; `suspended` → `SuspendedScreen`; loading → skeleton.
- [ ] **Groups list / home (4.x):** `GET /groups`; empty state; create CTA.
- [ ] **Create group:** `POST /groups`; navigate to `[id]`.
- [ ] **Group detail `[id]`:** `GET /groups/{id}`; show members entry, invite/share entry.
- [ ] **Invite/share:** `POST /groups/{id}/invites` → show code + share sheet with deep-link URL.
- [ ] **Join via code:** input code → `GET /invites/{code}` (preview) → `POST /invites/{code}/join`.
- [ ] **Deep-link join:** configure `expo-router` linking so `/invites/{code}` opens the preview/join screen; handle cold-start + warm-start.
- [ ] **Members:** `GET` members; owner-remove (`DELETE /groups/{id}/members/{userId}`); `POST /groups/{id}/leave`.
- [ ] Wire global states: Offline banner, Error+retry on query failure, Toasts for mutations, Loading skeletons.
- [ ] Document per-device run (LAN IP, `EXPO_PUBLIC_API_URL`, WSL2 mirrored networking) in `RUNNING.md`.
- [ ] (Optional) Expo-web Playwright smoke screenshots of each screen for visual QA.

## 4. Data model & migrations

None. M5 consumes the schema already shipped by M2 (`user`, better-auth tables) and M3 (`group`, `group_invite`, `group_member`). No new tables, columns, or enums.

## 5. API endpoints

None new — M5 is a **client** of endpoints already delivered by M2/M3. Consumed here:
- `POST /auth/start` (phone/email) — request OTP.
- `POST /auth/verify` — exchange OTP for session.
- `POST /auth/refresh`, `POST /auth/logout` — session lifecycle.
- `POST /users` — create profile; `PATCH /users/me` — edit; (`DELETE /users/me` deferred to M9 UI).
- session/me read — hydrate `authStore` (`account_status` drives the suspended gate).
- `GET /groups`, `POST /groups`, `GET /groups/{id}`, `PATCH /groups/{id}`.
- `POST /groups/{id}/invites`, `GET /invites/{code}`, `POST /invites/{code}/join`.
- `GET` group members, `DELETE /groups/{id}/members/{userId}`, `POST /groups/{id}/leave`.
- `GET /legal/privacy`, `GET /legal/terms`.
- Dev only: `GET /auth/dev/last-otp` (retrieve OTP without SMS/email in dev).

## 6. Mobile (Expo Go, Android)

- **Navigation:** `expo-router` with `(auth)` / `(app)` route groups; root layout hosts `AuthGate`; deep-link config for `/invites/{code}`.
- **Theme/UI:** `ThemeProvider` + Ember tokens (re-implemented from `reference/Spool.html`); `ui` primitive library (Screen, Text, Button, Input, OTPInput, Card, Avatar, Spinner, Toast).
- **Stores:** zustand `authStore` (token + user + status); platform-split secure storage (`expo-secure-store` native / `localStorage` web).
- **Data:** `react-query` provider + `queryKeys` factory; typed `api-client` against `packages/contracts`.
- **Screens added:** Welcome, Sign-in (phone+email), Verify OTP, Profile setup, Legal reader, `SuspendedScreen`; Groups list, Create group, Group detail `[id]`, Invite/share, Join (code + deep-link), Members.
- **Global states:** Offline, Loading skeleton, Error+retry, Toasts/rollover.

## 7. Tests (live-stack)

- **Expo-web Playwright (optional, recommended):** drive the web build against the live API:
  - Sign-in (phone) → verify (OTP fetched from `GET /auth/dev/last-otp`) → profile setup → lands in `(app)`. Assert session token persisted and `(app)` rendered.
  - Sign-in (email) variant → asserts both identifier paths reach verify.
  - Create group → appears in `GET /groups`; group detail loads.
  - Generate invite in user A's session → user B (second browser context) opens `/invites/{code}` deep-link → preview → join → B appears in members.
  - Capture screenshots per screen for visual QA against `reference/Spool.html`.
- **api-client unit/contract tests:** error envelope `{ error: { code, status, message } }` is parsed into typed `ApiError`; 401 surfaces as an auth error that clears the session; request/response shapes validate against `contracts` Zod DTOs.
- **authStore tests:** hydrate from secure store; `setSession`/`clear`; suspended status routes to `SuspendedScreen`.

## 8. Acceptance criteria

- App **boots in Expo Go on a real Android device** over LAN/Tailscale (no `127.0.0.1`).
- Every screen renders with the Ember dark theme tokens re-implemented from `reference/Spool.html`.
- **Android device check (primary):** on a real phone in Expo Go, a user completes **full sign-in via phone+email OTP** (welcome → sign-in → verify → profile setup → legal), then **creates a group and joins a group via an invite code (and via a deep-link)**; membership is reflected on both sides.
- `account_status=suspended` routes to `SuspendedScreen`; unauthenticated users can't reach `(app)` routes.
- API errors render the Error+retry / toast states rather than crashing.

## 9. Dependencies & prerequisites

- M0: LAN/Tailscale device↔backend reachability proven; `0.0.0.0` API bind; WSL2 mirrored networking.
- M1: error envelope + CORS (incl. PATCH/PUT/DELETE preflight) so RN/browser writes succeed.
- M2: phone+email OTP, sessions, dev OTP transport + `GET /auth/dev/last-otp`.
- M3: groups + invite/join + membership authz endpoints live.
- Libs (versions via `npx expo install --fix`, not guessed): `expo`, `expo-router`, `expo-secure-store`, `expo-linking`, `@tanstack/react-query`, `zustand`. If any animated primitive uses Reanimated 4.x, also add `react-native-worklets` + babel plugin `'react-native-worklets/plugin'`.
- `EXPO_PUBLIC_API_URL` set to the device-reachable LAN/Tailscale IP.

## 10. Learnings to apply (from PHASE1_WORK_RECAP.md)

- **Never trust Expo version guesses — `npx expo install --fix` is the source of truth** (§5 Mobile/Expo; §8.2). PLAN.md said RN 0.81; reality was RN 0.85.3.
- **Reanimated 4.x requires `react-native-worklets` + the `'react-native-worklets/plugin'` babel plugin** (not `reanimated/plugin`) (§5; §8.2) — only if an animated primitive needs it.
- **Phone can't reach `127.0.0.1`** — API binds `0.0.0.0`, device uses LAN IP via `EXPO_PUBLIC_API_URL`; WSL2 needs `networkingMode=mirrored` (§5 Infra/networking; §7).
- **Front-door HTTP for RN clients** depends on M1's `'*'` content-type parser + explicit CORS method list; a real preflight (not inject) is what exercises CORS (§5 API; §8.5).
- **`Spool.html` is a visual reference only** (~549 KB minified, not importable) — Ember tokens must be **re-implemented natively in RN** (§4 A7).
- **Platform-split via Metro `.web.ts`/`.native.ts`** is the proven shape — use it for secure-storage (and reuse the pattern for M6's upload) (§5 Upload; §9 Keep).
- Browser is the easy QA path; dev OTP retrievable via the dev endpoint (§7).

## 11. Open decisions / flags

- **Secure-store key naming + token refresh policy** — default: single `session_token` key; refresh on 401 via `POST /auth/refresh`, else clear and route to `(auth)`.
- **Deep-link scheme** — default: a custom scheme (`twenty4://invites/{code}`) plus universal/app-link config deferred to M14 (Expo Go uses the dev scheme).
- **Contacts discovery + notification priming screens** — out of scope for M5; default: stub routes (or omit) until P2 onboarding; do not block the core flow.
- **Username uniqueness/availability UX** — default: rely on the server's taxonomy error on `POST /users`; live availability check deferred.
- **Profile photo upload at setup** — default: placeholder avatar in M5; real image upload reuses M4/M6 upload transport later.
