// Shared e2e helpers: fresh identifiers, dev-OTP fetch, and the reusable
// sign-up→profile flow used across specs.
//
// react-native-web renders `testID` as the DOM attr `data-testid`. Input/OTPInput
// put the testID on a WRAPPER <div> (a View), so the real <input> is a descendant —
// hence `[data-testid="..."] input` for text fields.
import { join } from 'node:path';
import { expect, type Page, type Browser, type BrowserContext } from '@playwright/test';

// The live API. Read from the same env Expo uses; fall back to the known host.
export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://100.98.100.117:3000';

// The web app base. Contexts created via browser.newContext() do NOT inherit the
// config's `use.baseURL`, so we bake it in here for every context we open.
const PORT = Number(process.env.E2E_WEB_PORT ?? 8081);
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export const SESSION_TOKEN_KEY = 'twenty4.session_token';

// Anchor screenshots to e2e/screenshots regardless of process.cwd() (Playwright
// runs with cwd = apps/mobile, the package root). __dirname here is e2e/specs.
const SHOTS = join(__dirname, '..', 'screenshots');

// A fresh, isolated phone-ish context with baseURL baked in (so page.goto('/')
// resolves). Each call is a clean browser profile — no shared cookies/storage.
export async function newAppContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 390, height: 844 },
  });
}

// ── Fresh, collision-free identifiers per run ────────────────────────────────
// Phone: +1555 + 7 digits derived from Date.now() (+ a small random nudge so two
// calls in the same ms don't collide). Stays inside the 7–15 digit client check.
let _seq = 0;
export function freshPhone(): string {
  const base = (Date.now() % 10_000_000).toString().padStart(7, '0');
  // Nudge the last digit by a per-call sequence to avoid same-ms collisions.
  const nudged = (Number(base) + _seq++) % 10_000_000;
  return `+1555${nudged.toString().padStart(7, '0')}`;
}

export function freshEmail(): string {
  return `e2e_${Date.now()}_${_seq++}@twenty4.test`;
}

export function freshUsername(): string {
  // 3–30 chars, [a-z0-9_.] only.
  return `e2e_${Date.now().toString(36)}_${_seq++}`.slice(0, 30);
}

// ── Dev-OTP fetch (fallback / belt-and-suspenders) ───────────────────────────
// Mailpit web UI/API — captures email OTPs in dev (the email channel does NOT
// write to the phone-only Redis dev store, so we read its OTP from Mailpit).
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

// PHONE: GET /auth/dev/last-otp?identifier=&channel=phone → { identifier, code|null }.
//   The dev store is phone-only by design (otpTransport routes email → EmailService).
// EMAIL: read the latest Mailpit message addressed to the identifier; the 6-digit
//   code is in the subject "Your twenty4 code: <code>".
// The Verify screen also auto-fills in __DEV__, but we fetch the code ourselves so
// the test never depends on that timing.
export async function fetchDevOtp(
  ctx: BrowserContext,
  identifier: string,
  channel: 'phone' | 'email',
): Promise<string> {
  if (channel === 'email') return fetchEmailOtp(ctx, identifier);
  const url = `${API_URL}/auth/dev/last-otp?identifier=${encodeURIComponent(
    identifier,
  )}&channel=phone`;
  // Poll up to ~10s — the code is written right after /auth/start returns 202.
  for (let i = 0; i < 20; i++) {
    const res = await ctx.request.get(url);
    if (res.ok()) {
      const body = (await res.json()) as { code: string | null };
      if (body.code) return body.code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev OTP never appeared for ${identifier} (phone)`);
}

interface MailpitMessage {
  To?: { Address: string }[];
  Subject?: string;
  Created?: string;
}

async function fetchEmailOtp(ctx: BrowserContext, email: string): Promise<string> {
  const target = email.toLowerCase();
  for (let i = 0; i < 30; i++) {
    const res = await ctx.request.get(`${MAILPIT_URL}/api/v1/messages?limit=50`);
    if (res.ok()) {
      const body = (await res.json()) as { messages?: MailpitMessage[] };
      const mine = (body.messages ?? [])
        .filter((m) => (m.To ?? []).some((t) => t.Address?.toLowerCase() === target))
        .sort((a, b) => (b.Created ?? '').localeCompare(a.Created ?? ''));
      const subject = mine[0]?.Subject ?? '';
      const m = subject.match(/(\d{6})/);
      if (m?.[1]) return m[1];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`email OTP never appeared in Mailpit for ${email}`);
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

// Target the real <input> inside an Input/OTPInput testID wrapper.
export function inputIn(page: Page, testid: string) {
  return page.locator(`[data-testid="${testid}"] input`);
}

export function tid(page: Page, testid: string) {
  return page.locator(`[data-testid="${testid}"]`);
}

// ── The reusable sign-up → profile flow ──────────────────────────────────────
// Drives: welcome → get-started → sign-in (phone|email) → send → verify (dev OTP)
// → profile-setup (display name + username) → lands on Groups home.
//
// Returns the identifiers used. Takes screenshots when `screenshotPrefix` given.
export interface SignUpResult {
  identifier: string;
  username: string;
  displayName: string;
  channel: 'phone' | 'email';
}

export async function signUpFreshUser(
  page: Page,
  opts: { channel?: 'phone' | 'email'; screenshotPrefix?: string } = {},
): Promise<SignUpResult> {
  const channel = opts.channel ?? 'phone';
  const ctx = page.context();
  const identifier = channel === 'phone' ? freshPhone() : freshEmail();
  const username = freshUsername();
  const displayName = `E2E ${username}`;
  const prefix = opts.screenshotPrefix;

  // 1) Welcome.
  await page.goto('/');
  await expect(tid(page, 'auth-get-started-button')).toBeVisible({ timeout: 150_000 });
  if (prefix) await shot(page, `${prefix}-01-welcome`);
  await tid(page, 'auth-get-started-button').click();

  // 2) Sign-in. Phone is the default channel; switch for email.
  await expect(tid(page, 'auth-send-button')).toBeVisible();
  if (channel === 'email') {
    await tid(page, 'auth-channel-email').click();
  }
  await inputIn(page, 'auth-identifier-input').fill(identifier);
  if (prefix) await shot(page, `${prefix}-02-sign-in`);
  await tid(page, 'auth-send-button').click();

  // 3) Verify. The dev screen auto-fills the code; we also fetch it ourselves
  //    and type it so the test is robust regardless of auto-fill timing.
  await expect(tid(page, 'auth-otp-input')).toBeVisible({ timeout: 60_000 });
  const code = await fetchDevOtp(ctx, identifier, channel);
  // Clear whatever auto-fill put there, then type our fetched code.
  const otp = inputIn(page, 'auth-otp-input').first();
  await otp.click();
  // OTPInput is a single controlled value across cells; fill the first input.
  await otp.fill('');
  await otp.fill(code);
  if (prefix) await shot(page, `${prefix}-03-verify`);
  // onComplete auto-submits at 6 digits; click Verify too as a belt-and-suspenders.
  const verifyBtn = tid(page, 'auth-verify-button');
  if (await verifyBtn.isEnabled().catch(() => false)) {
    await verifyBtn.click().catch(() => {});
  }

  // 4) Profile setup (new user). Wait for either profile-setup OR groups home
  //    (in case this identifier somehow already had a profile).
  const onProfile = tid(page, 'auth-displayname-input');
  const onGroups = page.locator(
    '[data-testid="new-group-button"], [data-testid="empty-state"]',
  );
  await expect(onProfile.or(onGroups).first()).toBeVisible({ timeout: 60_000 });

  if (await onProfile.isVisible().catch(() => false)) {
    if (prefix) await shot(page, `${prefix}-04-profile-setup`);
    await inputIn(page, 'auth-displayname-input').fill(displayName);
    await inputIn(page, 'auth-username-input').fill(username);
    await tid(page, 'auth-continue-button').click();
  }

  // 5) Land on Groups home.
  await expect(onGroups.first()).toBeVisible({ timeout: 60_000 });

  return { identifier, username, displayName, channel };
}

// Assert the session token is persisted to localStorage (web secureStore).
export async function expectSessionToken(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((k) => window.localStorage.getItem(k), SESSION_TOKEN_KEY),
      { timeout: 30_000 },
    )
    .not.toBeNull();
}
