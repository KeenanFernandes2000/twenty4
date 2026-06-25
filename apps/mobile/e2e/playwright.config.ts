// Playwright config for the twenty4 M5 mobile web e2e suite.
//
// Drives the REAL Expo-web dev build (react-native-web) against the LIVE API
// (EXPO_PUBLIC_API_URL from apps/mobile/.env → http://100.98.100.117:3000).
//
// The Expo dev server is started for us via `webServer` below. Metro's FIRST
// bundle is slow, so timeouts are generous. A single headless Chromium project,
// phone-ish viewport, trace + screenshot on failure.
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_WEB_PORT ?? 8081);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

// Anchor artifact dirs to the config dir (Playwright runs with cwd = apps/mobile,
// the package root that owns node_modules/@playwright).
const HERE = __dirname;

// Allow running against an already-running dev server (set E2E_NO_WEBSERVER=1).
const reuseExisting = process.env.E2E_NO_WEBSERVER === '1';

export default defineConfig({
  testDir: './specs',
  // One worker: the live API has a per-IP OTP cap (20/15min) and flows share
  // browser contexts; serial keeps OTP usage predictable and avoids cap churn.
  workers: 1,
  fullyParallel: false,
  // Metro first-bundle + a multi-step login is slow; give each test room.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: join(HERE, 'playwright-report') }],
  ],
  outputDir: join(HERE, 'test-results'),

  use: {
    baseURL: BASE_URL,
    viewport: { width: 390, height: 844 }, // phone-ish
    // Metro's first page load can take 60–120s; allow plenty.
    navigationTimeout: 150_000,
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Pixel 5'],
        // Pin the cached chromium that's already installed in this sandbox.
        // (channel: 'chromium' / a system browser would also work.)
        viewport: { width: 390, height: 844 },
      },
    },
  ],

  // Start the Expo web DEV server (loads apps/mobile/.env so EXPO_PUBLIC_API_URL
  // is set). The dev server is more faithful for client-side routing than the
  // static `dist` export. Skip with E2E_NO_WEBSERVER=1 if you start it yourself.
  webServer: reuseExisting
    ? undefined
    : {
        command: `npx expo start --web --port ${PORT}`,
        cwd: '..', // run from apps/mobile so .env + metro config resolve
        url: BASE_URL,
        reuseExistingServer: true,
        // Metro cold-start can be very slow on first run.
        timeout: 240_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
