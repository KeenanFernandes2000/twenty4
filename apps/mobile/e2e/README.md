# M5 mobile-web e2e (Playwright)

The reusable headless verification tool for **M5** — the analog of `scripts/smoke.ts`
(M2–M4), but for the mobile app. It drives the **real rendered Expo-web build**
(react-native-web) in a headless Chromium against the **live API**, exercising the
full auth + groups + invite/join flows end-to-end.

The milestone's **core acceptance** lives in flow 4: a cross-context invite + join,
with membership reflected on **both** the inviter's and the joiner's side.

## What it covers

| Flow | What it asserts |
|------|-----------------|
| 1 | Phone sign-up → verify (dev OTP) → profile-setup → Groups home; `twenty4.session_token` persisted to `localStorage` |
| 2 | Email-channel sign-up reaches the app (lighter) |
| 3 | Create group → detail shows the name → list shows the new card |
| 4 | **Invite + cross-context join** — owner generates a code; a 2nd browser context signs up + joins; membership shows on both rosters (core acceptance) |
| 5 | Deep-link `/invites/<code>` renders cold (best-effort; `test.fixme`). **Known:** on a cold web load this route currently bounces to `/` (authed) or `/welcome` (logged-out) instead of rendering the invite screen — an expo-router/AuthGate cold-route quirk, recorded but non-failing. The WARM in-app preview→join is fully covered by flow 4. |

Each step writes a full-page screenshot to `screenshots/` for visual QA of the
Ember theme (warm dark `#161210`, ember accent `#ff7a52`, Nunito headings, pill CTAs).

## Prerequisites

1. **Backend stack UP** — API + worker + docker (postgres 5433 / redis 6380 / minio 9000).
   Confirm health: `curl http://100.98.100.117:3000/health` → `{"status":"ok"}`.
   The suite reads `EXPO_PUBLIC_API_URL` from `apps/mobile/.env` (and uses it for the
   direct dev-OTP fetch). Keep it pointed at the live API.
2. **Playwright + Chromium installed** — `@playwright/test` is a devDep of
   `apps/mobile`. Install the browser once: `npx playwright install chromium`.
3. **Expo web dev server** — started automatically by the Playwright `webServer`
   config (`npx expo start --web --port 8081`, run from `apps/mobile`). Metro's
   first bundle is slow (60–120s) — the config allows for it. To use a server you
   started yourself, set `E2E_NO_WEBSERVER=1`.

## Run

From the repo root:

```bash
bun run test:e2e:mobile
```

or directly:

```bash
cd apps/mobile/e2e && npx playwright test
```

Useful env vars:

- `EXPO_PUBLIC_API_URL` — live API base (defaults to the `.env` value / the known host).
- `E2E_WEB_PORT` (default `8081`), `E2E_BASE_URL` — where the web app serves.
- `E2E_NO_WEBSERVER=1` — don't auto-start Expo; point at an already-running server.

HTML report: `npx playwright show-report playwright-report` (after a run).

## OTP rate-limit caveat (environmental, not a bug)

The API caps OTP starts per-IP (20 / 15 min). Each sign-up consumes one. A full run
signs up ~3–4 fresh users, so repeated back-to-back runs can hit the cap and surface
as a `429 RATE_LIMITED`. That's **environmental**, not an app bug. Flush the OTP
counters in Redis to reset:

```bash
redis-cli -p 6380 --scan --pattern 'otp:*' | xargs -r redis-cli -p 6380 del
```

The suite uses **fresh unique identifiers per run** (`+1555` + timestamp digits /
`e2e_<ts>@twenty4.test`) to avoid collisions, and reads each OTP via the dev route
`GET /auth/dev/last-otp` so it never depends on a real SMS/email transport.

## Notes for maintainers

- `testID` → DOM `data-testid` (react-native-web). `Input`/`OTPInput` put the testID
  on a **wrapper** `<div>`, so target the descendant `<input>`:
  `[data-testid="auth-identifier-input"] input`. Helpers `inputIn()` / `tid()` encode this.
- Tests run **serially** (`workers: 1`) — flows 3/4 reuse the owner context + group
  from earlier steps, and serial keeps OTP usage predictable against the per-IP cap.
- Artifacts (`screenshots/`, `test-results/`, `playwright-report/`) are gitignored;
  the specs/config/README are committed.
