// M7 mobile-web e2e — the headless verification of the montage pipeline
// (generate → poll → review → publish). Drives the REAL Expo-web build against
// the LIVE API + MinIO + Redis + the BullMQ/Remotion render worker.
//
// Flow (one serial happy path):
//   1. Sign up a fresh user + create a group via the API (publish target).
//   2. Import several fresh-EXIF JPGs (DateTimeOriginal = now) so the worker
//      validates them as today's media → readiness flips ready (reuses M6's
//      upload/import path + the self-contained EXIF injector).
//   3. Tap the (now-enabled) generate button → POST /montages → the generating
//      host screen (montage-generating). Read the montage id off the web URL.
//   4. Poll GET /montages/:id to draft_ready (REQUIRES the render worker; a real
//      Remotion render is ~80s, so the deadline loop is generous).
//   5. Review screen: assert the inline mp4 preview + theme picker render; select
//      the group and Publish → publish-success.
//   6. API cross-check: GET /montages/:id is `published` with publishedAt/expiryAt.
//
// ── Worker dependence ────────────────────────────────────────────────────────
// Steps 1–3 only need API + MinIO (upload/validate/enqueue). Steps 4–6 (the
// draft_ready transition, the preview, and publish) REQUIRE the render worker to
// be running. Those assertions are flagged inline.
//
// Selectors are aligned to the M7 testIDs: generate-button, montage-generating,
// montage-progress, montage-review, montage-preview, theme-select-<theme>,
// group-select-<id>, montage-publish, publish-success.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { signUpFreshUser, newAppContext, API_URL, shot, tid, SESSION_TOKEN_KEY } from './helpers';

test.describe.configure({ mode: 'serial' });

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SAMPLES = join(__dirname, '..', '..', '..', '..', 'fixtures', 'sample-media');
const SAMPLE_JPG = join(SAMPLES, 'IMG20260525215827.jpg'); // ~2.5MB, EXIF date in MAY
const GEN_DIR = join(__dirname, '..', '.fixtures-generated');

// Enough valid items to clear the montage min-media floor (spec default ~3).
const FRESH_COUNT = 4;

// ── Self-contained EXIF DateTimeOriginal injector (no deps; mirrors m6.e2e) ──
function stripApp1(jpeg: Buffer): Buffer {
  let i = 2;
  while (i + 4 <= jpeg.length) {
    if (jpeg[i] !== 0xff) break;
    const marker = jpeg[i + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = ((jpeg[i + 2] ?? 0) << 8) | (jpeg[i + 3] ?? 0);
    if (marker === 0xe1) return Buffer.concat([jpeg.subarray(0, i), jpeg.subarray(i + 2 + len)]);
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return jpeg;
}

function buildExifApp1(dtStr: string): Buffer {
  const dt = Buffer.from(dtStr + ' ', 'latin1');
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const header = Buffer.concat([Buffer.from('II', 'latin1'), u16(0x002a), u32(8)]);
  const EXIF_IFD_OFFSET = 26;
  const DT_VALUE_OFFSET = 44;
  const ifd0 = Buffer.concat([u16(1), u16(0x8769), u16(4), u32(1), u32(EXIF_IFD_OFFSET), u32(0)]);
  const exifIfd = Buffer.concat([u16(1), u16(0x9003), u16(2), u32(20), u32(DT_VALUE_OFFSET), u32(0)]);
  const tiff = Buffer.concat([header, ifd0, exifIfd, dt]);
  const exifId = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const body = Buffer.concat([exifId, tiff]);
  const segLen = body.length + 2;
  return Buffer.concat([Buffer.from([0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff]), body]);
}

function exifNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Write N distinct fresh-EXIF JPGs (DateTimeOriginal = now) and return their paths.
function makeFreshExifJpgs(n: number): string[] {
  mkdirSync(GEN_DIR, { recursive: true });
  const base = readFileSync(SAMPLE_JPG);
  const app1 = buildExifApp1(exifNow());
  const stripped = stripApp1(base).subarray(2);
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const out = Buffer.concat([base.subarray(0, 2), app1, stripped]);
    const p = join(GEN_DIR, `m7-fresh-${Date.now()}-${i}.jpg`);
    writeFileSync(p, out);
    paths.push(p);
  }
  return paths;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// Import N files in one web filechooser (the picker sets `multiple`).
async function importFiles(page: Page, absPaths: string[]): Promise<void> {
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    tid(page, 'import-media-button').click(),
  ]);
  await fc.setFiles(absPaths);
}

async function bearer(page: Page): Promise<string> {
  const token = await page.evaluate((k) => window.localStorage.getItem(k), SESSION_TOKEN_KEY);
  expect(token, 'session token in localStorage').toBeTruthy();
  return token as string;
}

interface ApiMediaItem {
  id: string;
  validationStatus: 'pending' | 'valid' | 'invalid';
  processingStatus: string;
  mediaType: 'photo' | 'video';
}

async function getTodayApi(ctx: BrowserContext, token: string): Promise<ApiMediaItem[]> {
  const res = await ctx.request.get(`${API_URL}/media/today`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `GET /media/today → ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { items: ApiMediaItem[] }).items;
}

async function pollTodayApi(
  ctx: BrowserContext,
  token: string,
  pred: (items: ApiMediaItem[]) => boolean,
  timeoutMs = 40_000,
): Promise<ApiMediaItem[]> {
  const deadline = Date.now() + timeoutMs;
  let items: ApiMediaItem[] = [];
  while (Date.now() < deadline) {
    items = await getTodayApi(ctx, token);
    if (pred(items)) return items;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return items;
}

interface ApiMontage {
  id: string;
  status: string;
  previewUrl: string | null;
  publishedAt: string | null;
  expiryAt: string | null;
  error: string | null;
}

async function getMontageApi(ctx: BrowserContext, token: string, id: string): Promise<ApiMontage> {
  const res = await ctx.request.get(`${API_URL}/montages/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `GET /montages/${id} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as ApiMontage;
}

// Deadline poll of GET /montages/:id (the render takes ~80s → generous default).
async function pollMontageApi(
  ctx: BrowserContext,
  token: string,
  id: string,
  pred: (m: ApiMontage) => boolean,
  timeoutMs = 150_000,
): Promise<ApiMontage> {
  const deadline = Date.now() + timeoutMs;
  let m = await getMontageApi(ctx, token, id);
  while (Date.now() < deadline) {
    m = await getMontageApi(ctx, token, id);
    if (pred(m)) return m;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return m;
}

// Create a group straight via the API so we have a publish target (group-select-<id>).
async function createGroupApi(ctx: BrowserContext, token: string, name: string): Promise<string> {
  const res = await ctx.request.post(`${API_URL}/groups`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name },
  });
  expect(res.ok(), `POST /groups → ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

async function goToToday(page: Page): Promise<void> {
  const cta = page.locator('[data-testid="go-to-today"]:visible').first();
  await expect(cta).toBeVisible({ timeout: 30_000 });
  await cta.click();
  await expect(tid(page, 'today-screen')).toBeVisible({ timeout: 30_000 });
}

// Wait for an upload card to finish (Uploaded ✓ or deduped into the today list).
async function waitUploadSettled(card: ReturnType<Page['locator']>, timeoutMs = 60_000): Promise<void> {
  const status = card.locator('[data-testid="upload-status"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await card.count()) === 0) return;
    const txt = (await status.innerText().catch(() => '')).trim();
    if (txt === 'Uploaded ✓') return;
    if (txt === 'Failed' || txt === 'Canceled') throw new Error(`upload settled to "${txt}"`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('upload did not settle within timeout');
}

// ── Shared serial state ──────────────────────────────────────────────────────
let context: BrowserContext;
let page: Page;
let token = '';
let groupId = '';
let montageId = '';

test.afterAll(async () => {
  await context?.close().catch(() => {});
});

// ── Step 1: sign up + group + import valid media + generate ──────────────────
test('flow 1 — import media, generate, and reach the generating screen', async ({ browser }) => {
  test.setTimeout(240_000);
  context = await newAppContext(browser);
  page = await context.newPage();

  await signUpFreshUser(page, { channel: 'phone', screenshotPrefix: 'm7-flow1' });
  await goToToday(page);
  token = await bearer(page);

  // Publish target for later.
  groupId = await createGroupApi(context, token, `m7 recap ${Date.now()}`);

  // Import several fresh-EXIF JPGs so they validate as today's media.
  const files = makeFreshExifJpgs(FRESH_COUNT);
  await importFiles(page, files);

  // Each upload card settles (Uploaded ✓ or deduped into the today list).
  const firstCard = tid(page, 'upload-card').first();
  await expect(firstCard).toBeVisible({ timeout: 30_000 });
  await waitUploadSettled(firstCard);
  await shot(page, 'm7-flow1-uploaded');

  // Wait for the worker to validate ≥ the min floor as today's media.
  const valid = await pollTodayApi(
    context,
    token,
    (items) => items.filter((i) => i.validationStatus === 'valid').length >= 3,
    40_000,
  );
  const validCount = valid.filter((i) => i.validationStatus === 'valid').length;
  // eslint-disable-next-line no-console
  console.log(`[m7][flow1] validCount=${validCount} statuses=[${valid.map((i) => i.validationStatus).join(',')}]`);

  // Readiness flips ready → the generate button enables.
  await expect(tid(page, 'readiness-state')).toHaveText('ready', { timeout: 30_000 });
  const generate = tid(page, 'generate-button');
  await expect(generate).toBeVisible({ timeout: 30_000 });
  await expect(generate).toBeEnabled();

  // Generate → the generating host screen renders; capture the montage id from the URL.
  await generate.click();
  await expect(tid(page, 'montage-generating')).toBeVisible({ timeout: 30_000 });
  await expect(tid(page, 'montage-progress')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'm7-flow1-generating');

  const m = page.url().match(/montage\/([0-9a-fA-F-]{36})/);
  expect(m, `montage id in URL (${page.url()})`).toBeTruthy();
  montageId = m![1]!;
  // eslint-disable-next-line no-console
  console.log(`[m7][flow1] montageId=${montageId}`);

  // API cross-check: the montage exists and is generating.
  const created = await getMontageApi(context, token, montageId);
  expect(['generating', 'draft_ready']).toContain(created.status);
});

// ── Step 2: poll to draft_ready → review screen renders (REQUIRES worker) ────
test('flow 2 — render completes → review screen with inline preview', async () => {
  test.setTimeout(240_000);
  expect(montageId, 'montageId from flow 1').toBeTruthy();

  // REQUIRES the render worker: poll the API to draft_ready (a real Remotion
  // render is ~80s; allow up to 150s for the single worker).
  const done = await pollMontageApi(
    context,
    token,
    montageId,
    (mo) => mo.status === 'draft_ready' || mo.status === 'failed',
    150_000,
  );
  // eslint-disable-next-line no-console
  console.log(`[m7][flow2] montage settled status=${done.status} error=${done.error ?? ''}`);
  expect(done.status, 'render should reach draft_ready (worker must be running)').toBe('draft_ready');
  expect(done.previewUrl, 'signed preview URL present once draft_ready').toBeTruthy();

  // The client poll (2.5s) flips the host screen to the review state.
  await expect(tid(page, 'montage-review')).toBeVisible({ timeout: 30_000 });
  await expect(tid(page, 'montage-preview')).toBeVisible({ timeout: 30_000 });
  // The basic theme picker is fed by GET /montages/options.
  await expect(tid(page, 'theme-select-chill')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'm7-flow2-review');
});

// ── Step 3: publish to the group → publish-success (REQUIRES worker upstream) ─
test('flow 3 — publish to a group → publish-success + API published', async () => {
  test.setTimeout(120_000);
  expect(montageId, 'montageId from flow 1').toBeTruthy();
  expect(groupId, 'groupId from flow 1').toBeTruthy();

  // Select the group, then Publish.
  const groupToggle = tid(page, `group-select-${groupId}`);
  await expect(groupToggle).toBeVisible({ timeout: 30_000 });
  await groupToggle.click();

  const publishBtn = tid(page, 'montage-publish');
  await expect(publishBtn).toBeEnabled({ timeout: 30_000 });
  await publishBtn.click();

  // Publish-success state renders.
  await expect(tid(page, 'publish-success')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'm7-flow3-published');

  // API cross-check: montage is published with publishedAt + expiryAt (+24h).
  const published = await pollMontageApi(
    context,
    token,
    montageId,
    (mo) => mo.status === 'published',
    30_000,
  );
  expect(published.status).toBe('published');
  expect(published.publishedAt, 'publishedAt set on publish').toBeTruthy();
  expect(published.expiryAt, 'expiryAt set on publish (+24h)').toBeTruthy();
  // eslint-disable-next-line no-console
  console.log(`[m7][flow3] published publishedAt=${published.publishedAt} expiryAt=${published.expiryAt}`);
});
