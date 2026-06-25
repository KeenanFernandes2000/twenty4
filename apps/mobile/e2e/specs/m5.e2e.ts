// M5 mobile-web e2e — the reusable headless verification tool for M5 (the analog
// of scripts/smoke.ts for M2–M4). Drives the REAL Expo-web build against the LIVE
// API and exercises the milestone's core acceptance: cross-context invite + join
// with membership reflected on BOTH sides.
//
// Flows:
//   1. Phone sign-up happy path (+ localStorage session token assertion)
//   2. Email-channel sign-up (lighter)
//   3. Create group → detail → back-to-list shows the card
//   4. Invite + cross-context join (core acceptance) → members roster on both sides
//   5a. Deep-link /invites/<code> cold load — AUTHENTICATED → preview + join
//   5b. Deep-link /invites/<code> cold load — LOGGED-OUT → sign-in CTA (no crash)
//
// Uses FRESH unique identifiers per run to dodge collisions + the per-IP OTP cap.
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import {
  signUpFreshUser,
  expectSessionToken,
  newAppContext,
  setAccountStatusByPhone,
  fetchDevOtp,
  shot,
  tid,
  inputIn,
  SESSION_TOKEN_KEY,
} from './helpers';

// Serial: flow 3/4 reuse the owner context+group created in earlier steps.
test.describe.configure({ mode: 'serial' });

// Shared owner state across the serial flows.
let ownerContext: BrowserContext;
let ownerPage: Page;
let ownerUser: Awaited<ReturnType<typeof signUpFreshUser>>;
let groupName = '';
let groupId = '';
let inviteCode = '';

test.afterAll(async () => {
  await ownerContext?.close();
});

// ── Flow 1: Phone sign-up happy path ─────────────────────────────────────────
test('flow 1 — phone sign-up reaches Groups home + persists session', async ({
  browser,
}) => {
  ownerContext = await newAppContext(browser);
  ownerPage = await ownerContext.newPage();

  ownerUser = await signUpFreshUser(ownerPage, {
    channel: 'phone',
    screenshotPrefix: 'flow1',
  });

  // Groups home: empty-state or new-group button visible.
  await expect(
    ownerPage
      .locator('[data-testid="new-group-button"], [data-testid="empty-state"]')
      .first(),
  ).toBeVisible();
  await shot(ownerPage, 'flow1-05-groups-empty');

  // Session token persisted to localStorage (web secureStore).
  await expectSessionToken(ownerPage);
});

// ── Flow 2: Email-channel sign-up (lighter) ──────────────────────────────────
test('flow 2 — email channel signs up end-to-end', async ({ browser }) => {
  const ctx = await newAppContext(browser);
  const page = await ctx.newPage();
  try {
    await signUpFreshUser(page, { channel: 'email', screenshotPrefix: 'flow2' });
    // Proves the email channel path reaches the app.
    await expect(
      page
        .locator('[data-testid="new-group-button"], [data-testid="empty-state"]')
        .first(),
    ).toBeVisible();
    await expectSessionToken(page);
  } finally {
    await ctx.close();
  }
});

// ── Flow 3: Create group ─────────────────────────────────────────────────────
test('flow 3 — create a group, see detail + list card', async () => {
  groupName = `E2E Crew ${Date.now().toString(36)}`;

  await tid(ownerPage, 'new-group-button').click();
  await expect(tid(ownerPage, 'group-name-input')).toBeVisible();
  await inputIn(ownerPage, 'group-name-input').fill(groupName);
  await tid(ownerPage, 'create-group-button').click();

  // Lands on detail with the name shown.
  await expect(tid(ownerPage, 'group-detail-name')).toHaveText(groupName, {
    timeout: 30_000,
  });
  await shot(ownerPage, 'flow3-01-group-detail');

  // Back to the list → the new group card is present.
  // (Use .first(): expo-router may keep the previous screen's header mounted
  // during a stack transition, so multiple back buttons can be present.)
  await tid(ownerPage, 'header-back-button').first().click();
  await expect(tid(ownerPage, 'groups-list')).toBeVisible({ timeout: 30_000 });
  await expect(
    ownerPage.locator('[data-testid^="group-card-"]', { hasText: groupName }),
  ).toBeVisible();
  await shot(ownerPage, 'flow3-02-groups-list-with-group');
});

// ── Flow 4: Invite + cross-context join (CORE ACCEPTANCE) ────────────────────
test('flow 4 — invite + cross-context join; membership on both sides', async ({
  browser,
}) => {
  // Owner (context A): open the group → Invite → generate code.
  const ownerCard = ownerPage.locator('[data-testid^="group-card-"]', {
    hasText: groupName,
  });
  // Capture the groupId from the card's testID (group-card-<id>) so we can
  // navigate the owner directly later (robuster than stack back-navigation).
  groupId = (await ownerCard.getAttribute('data-testid'))!.replace('group-card-', '');
  expect(groupId.length).toBeGreaterThan(0);
  await ownerCard.click();
  await expect(tid(ownerPage, 'group-detail-name')).toHaveText(groupName);
  await tid(ownerPage, 'invite-action').click();
  await tid(ownerPage, 'generate-invite-button').click();

  await expect(tid(ownerPage, 'invite-code')).toBeVisible({ timeout: 30_000 });
  inviteCode = (await tid(ownerPage, 'invite-code').innerText()).trim();
  expect(inviteCode.length).toBeGreaterThan(0);
  await shot(ownerPage, 'flow4-01-invite-code');

  // Joiner (context B): a fresh user signs up, then joins via the code.
  const ctxB = await newAppContext(browser);
  const pageB = await ctxB.newPage();
  let joiner: Awaited<ReturnType<typeof signUpFreshUser>>;
  try {
    joiner = await signUpFreshUser(pageB, { channel: 'phone' });

    // Join flow.
    await tid(pageB, 'join-button').click();
    await expect(tid(pageB, 'join-code-input')).toBeVisible();
    await inputIn(pageB, 'join-code-input').fill(inviteCode);
    await tid(pageB, 'join-preview-button').click();

    // Preview shows the group name.
    await expect(tid(pageB, 'invite-preview-name')).toHaveText(groupName, {
      timeout: 30_000,
    });
    await shot(pageB, 'flow4-02-join-preview');
    await tid(pageB, 'invite-join-button').click();

    // B lands in the group detail.
    await expect(tid(pageB, 'group-detail-name')).toHaveText(groupName, {
      timeout: 30_000,
    });
    await shot(pageB, 'flow4-03-joiner-in-group');

    // B sees itself in the members roster.
    await tid(pageB, 'members-action').click();
    await expect(tid(pageB, 'members-list')).toBeVisible({ timeout: 30_000 });
    await expect(
      pageB.locator('[data-testid="members-list"]', { hasText: joiner.username }),
    ).toBeVisible();
    await shot(pageB, 'flow4-04-joiner-members');

    // ── Owner side (context A): the joiner appears in OUR members roster. ──
    // Navigate the owner DIRECTLY to the members route (avoids brittle stack
    // back-navigation through stacked screens). This re-fetches the live roster,
    // so the new membership must be reflected.
    // expo-router strips route groups from web URLs: the clean path is
    // /groups/<id>/members (NOT /(app)/groups/...).
    await ownerPage.goto(`/groups/${groupId}/members`);
    await expect(tid(ownerPage, 'members-list')).toBeVisible({ timeout: 30_000 });
    // Membership reflected on the OWNER side: joiner's username present + count 2.
    await expect(
      ownerPage.locator('[data-testid="members-list"]', { hasText: joiner.username }),
    ).toBeVisible({ timeout: 30_000 });
    const rows = ownerPage.locator('[data-testid^="member-row-"]');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await shot(ownerPage, 'flow4-05-owner-members');
  } finally {
    await ctxB.close();
  }
});

// ── Flow 5: Deep-link /invites/<code> cold-load (AuthGate passthrough fix) ─────
// A COLD web navigation to the standalone /invites/<code> route (which lives OUTSIDE
// both the (auth) and (app) groups) must RENDER the deep-link screen — not bounce.
// Two assertions:
//   (a) AUTHENTICATED cold load → the invite preview + join unit renders, and the
//       user can join the group.
//   (b) LOGGED-OUT cold load → the "Sign in to join" CTA renders (no authed preview
//       call, so no 401 → clear() crash).
//
// Previously the AuthGate bounced authed users off this route ("authenticated AND
// not in (app) → replace('/(app)')") and the logged-out branch called the authed
// GET /invites/:code (401 → onUnauthorized). Both are now fixed; this asserts it.
test('flow 5a — authenticated cold deep-link renders preview + can join', async ({
  browser,
}) => {
  test.skip(!inviteCode, 'no invite code from flow 4');
  test.setTimeout(180_000);

  // Fresh user (NOT yet a member) in their own context → a real authenticated
  // session persisted to localStorage. The subsequent page.goto is a genuine COLD
  // document load (full reload) of the standalone deep-link route.
  const ctx = await newAppContext(browser);
  const page = await ctx.newPage();
  try {
    const joiner = await signUpFreshUser(page, {
      channel: 'phone',
      screenshotPrefix: 'flow5a',
    });
    await expectSessionToken(page);

    // COLD navigate to the deep link (authenticated). The gate must pass it through.
    await page.goto(`/invites/${inviteCode}`);

    // The shared InvitePreviewJoin unit renders the preview for the authed user.
    await expect(tid(page, 'invite-preview')).toBeVisible({ timeout: 30_000 });
    await expect(tid(page, 'invite-preview-name')).toHaveText(groupName, {
      timeout: 30_000,
    });
    await shot(page, 'flow5-deeplink-invite');

    // And the user can JOIN straight from the cold deep link.
    await tid(page, 'invite-join-button').click();
    await expect(tid(page, 'group-detail-name')).toHaveText(groupName, {
      timeout: 30_000,
    });

    // Sees itself in the roster — membership took.
    await tid(page, 'members-action').click();
    await expect(tid(page, 'members-list')).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-testid="members-list"]', { hasText: joiner.username }),
    ).toBeVisible({ timeout: 30_000 });
    await shot(page, 'flow5-02-joined-from-deeplink');
  } finally {
    await ctx.close().catch(() => {});
  }
});

test('flow 5b — logged-out cold deep-link shows sign-in CTA (no crash)', async ({
  browser,
}) => {
  test.skip(!inviteCode, 'no invite code from flow 4');
  test.setTimeout(120_000);

  // Pristine, logged-OUT context → COLD navigate to the deep link.
  const ctx = await newAppContext(browser);
  const page = await ctx.newPage();
  try {
    await page.goto(`/invites/${inviteCode}`);

    // The sign-in CTA renders; the gate did NOT bounce us to /welcome, and the
    // logged-out branch did NOT call the authed preview (which would 401 → clear()).
    await expect(tid(page, 'invite-signin-button')).toBeVisible({ timeout: 30_000 });
    await shot(page, 'flow5-03-deeplink-signin-cta');

    // Session token must still be absent (no spurious auth side-effects).
    const token = await page.evaluate(
      (k) => window.localStorage.getItem(k),
      'twenty4.session_token',
    );
    expect(token).toBeNull();
  } finally {
    await ctx.close().catch(() => {});
  }
});

// ── Flow 6: Account switch in ONE context drops stale cross-account cache ──────
// Regression guard for the react-query cache bug: logout of A → login as B must
// show B's data IMMEDIATELY (no manual pull-to-refresh), never A's cached groups.
// authStore.clear() now calls queryClient.clear() on logout (and setSession() does
// too as a belt-and-suspenders). We sign up A, give A a group, sign out, sign up a
// fresh B in the SAME browser context, and assert B's Groups home is empty with
// A's group card absent — with no refresh in between.
test('flow 6 — account switch clears stale cross-account query cache', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const ctx = await newAppContext(browser);
  const page = await ctx.newPage();
  try {
    // ── User A: sign up and create a group so A has a NON-empty groups list. ──
    const userA = await signUpFreshUser(page, {
      channel: 'phone',
      screenshotPrefix: 'flow6a',
    });
    const aGroupName = `A Crew ${Date.now().toString(36)}`;

    await tid(page, 'new-group-button').click();
    await expect(tid(page, 'group-name-input')).toBeVisible();
    await inputIn(page, 'group-name-input').fill(aGroupName);
    await tid(page, 'create-group-button').click();
    await expect(tid(page, 'group-detail-name')).toHaveText(aGroupName, {
      timeout: 30_000,
    });

    // Back to the list → A's group card is present (cache now holds A's groups).
    await tid(page, 'header-back-button').first().click();
    await expect(tid(page, 'groups-list')).toBeVisible({ timeout: 30_000 });
    const aCard = page.locator('[data-testid^="group-card-"]', { hasText: aGroupName });
    await expect(aCard).toBeVisible();
    await shot(page, 'flow6-01-userA-with-group');

    // ── Sign out (clear() → queryClient.clear() → AuthGate → welcome). ──
    await tid(page, 'sign-out-button').click();
    await expect(tid(page, 'auth-get-started-button')).toBeVisible({
      timeout: 60_000,
    });
    // Session token gone after logout.
    await expect
      .poll(
        async () => page.evaluate((k) => window.localStorage.getItem(k), SESSION_TOKEN_KEY),
        { timeout: 30_000 },
      )
      .toBeNull();

    // ── Fresh User B in the SAME context (the whole point: same-session switch). ──
    const userB = await signUpFreshUser(page, {
      channel: 'phone',
      screenshotPrefix: 'flow6b',
    });
    expect(userB.identifier).not.toEqual(userA.identifier);

    // B's Groups home must show the EMPTY state IMMEDIATELY (no manual refresh),
    // and A's group must NOT be visible (stale cache would have leaked it).
    await expect(tid(page, 'empty-state')).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-testid^="group-card-"]', { hasText: aGroupName }),
    ).toHaveCount(0);
    await expect(page.getByText(aGroupName)).toHaveCount(0);
    await shot(page, 'flow6-02-userB-empty-no-A-groups');
  } finally {
    await ctx.close().catch(() => {});
  }
});

// ── Flow 7: Suspended account hits the post-verify 403 notice (no generic toast) ─
// Proves Fix 2: a suspended account that enters the OTP flow and submits a valid
// code gets the dedicated AccountRestrictedNotice (full-screen), NOT a cryptic
// error toast, and NO session token is stored. We deliberately do NOT reject at
// /auth/start (anti-enumeration), so the notice is surfaced at verify time.
test('flow 7 — suspended account shows restricted notice at verify (no session)', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  // 1) Sign up a fresh user and capture their phone identifier.
  const setupCtx = await newAppContext(browser);
  const setupPage = await setupCtx.newPage();
  let phone = '';
  try {
    const user = await signUpFreshUser(setupPage, { channel: 'phone' });
    phone = user.identifier;
  } finally {
    await setupCtx.close().catch(() => {});
  }
  expect(phone.length).toBeGreaterThan(0);

  // 2) Suspend them directly in Postgres (docker compose exec → fallback docker exec).
  const suspended = setAccountStatusByPhone(phone, 'suspended');
  test.skip(
    !suspended,
    `could not suspend ${phone} in the DB (docker unreachable from test env) — see console`,
  );

  // 3) Fresh context: drive welcome → phone sign-in → verify → expect the notice.
  const ctx = await newAppContext(browser);
  const page = await ctx.newPage();
  try {
    await page.goto('/');
    await expect(tid(page, 'auth-get-started-button')).toBeVisible({ timeout: 150_000 });
    await tid(page, 'auth-get-started-button').click();

    await expect(tid(page, 'auth-send-button')).toBeVisible();
    // Phone is the default channel.
    await inputIn(page, 'auth-identifier-input').fill(phone);
    await tid(page, 'auth-send-button').click();

    // Verify: fetch the dev OTP and submit it.
    await expect(tid(page, 'auth-otp-input')).toBeVisible({ timeout: 60_000 });
    const code = await fetchDevOtp(ctx, phone, 'phone');
    const otp = inputIn(page, 'auth-otp-input').first();
    await otp.click();
    await otp.fill('');
    await otp.fill(code);
    const verifyBtn = tid(page, 'auth-verify-button');
    if (await verifyBtn.isEnabled().catch(() => false)) {
      await verifyBtn.click().catch(() => {});
    }

    // The dedicated restricted notice renders (NOT a generic toast).
    await expect(tid(page, 'restricted-notice')).toBeVisible({ timeout: 30_000 });
    await shot(page, 'polish-suspended-notice');

    // No session token was stored (verify minted, gate tore it down → 403 thrown
    // before setSession()).
    const token = await page.evaluate(
      (k) => window.localStorage.getItem(k),
      SESSION_TOKEN_KEY,
    );
    expect(token).toBeNull();

    // "Back to sign in" returns to welcome: the restricted notice unmounts and a
    // VISIBLE welcome "Get started" CTA is present. (expo-router on web can keep a
    // prior welcome instance in the DOM as `hidden`, so we filter to :visible rather
    // than .first(), which would match the backgrounded one.)
    await tid(page, 'restricted-back-button').click();
    await expect(tid(page, 'restricted-notice')).toBeHidden({ timeout: 30_000 });
    await expect(
      page.locator('[data-testid="auth-get-started-button"]:visible'),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await ctx.close().catch(() => {});
    // Throwaway account; convenience reset so a re-run with the same phone re-uses it.
    if (phone) setAccountStatusByPhone(phone, 'active');
  }
});
