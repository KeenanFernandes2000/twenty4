#!/usr/bin/env bun
// twenty4 — one-command end-to-end SMOKE TEST for milestones M0–M4.
//
// Runs against a LIVE server and prints a clear per-milestone PASS/FAIL.
// Self-contained: uses only `fetch` + Bun/Node stdlib, generates its own test
// media inline (no fixtures), creates throwaway users/group/media via the real
// API, and best-effort cleans up everything it created at the end.
//
// USAGE:
//   bun scripts/smoke.ts [--api <url>] [--seed <n>]
//     --api   base URL of the API (default http://localhost:3000)
//     --seed  base integer for the throwaway phone numbers. If omitted, a
//             per-run counter is auto-incremented (persisted in a local dotfile)
//             so every run uses FRESH users — required because account deletion
//             is a soft-delete, so a given phone can only be registered once.
//
// Works from a laptop AND from the phone (Termux + Bun) — just change --api,
// e.g.  bun scripts/smoke.ts --api http://100.98.100.117:3000
//
// REQUIRES (all must be up first):
//   - docker stack (postgres, redis, minio)   — docker compose up -d
//   - the API:     bun services/api/src/index.ts
//   - the worker:  bun services/worker/src/index.ts   (needed for M4 validation)
//
// Exit code 0 only if ALL checks pass; non-zero otherwise.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ----------------------------------------------------------------------------
// args + per-run seed (unique identifiers each run; --seed pins a fixed base)
// ----------------------------------------------------------------------------
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const API = (arg("--api") ?? "http://localhost:3000").replace(/\/$/, "");

// Each run needs distinct phone identifiers (account deletion is a soft-delete,
// so reusing a phone is rejected with ACCOUNT_DELETED). We reserve a block of 3
// identifiers per run (owner, joiner, stranger), so step the counter by 3.
// Kept in the OS temp dir (not the repo) so it never shows up in git status.
const SEED_FILE = join(tmpdir(), "twenty4-smoke-seed");
const SEED_BASE = 5550100;
function nextSeed(): number {
  const explicit = arg("--seed");
  if (explicit !== undefined) return Number(explicit);
  let cur = SEED_BASE;
  try {
    if (existsSync(SEED_FILE)) cur = Number(readFileSync(SEED_FILE, "utf8").trim()) || SEED_BASE;
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(SEED_FILE, String(cur + 3), "utf8");
  } catch {
    /* ignore — fall back to base if not writable (e.g. read-only fs) */
  }
  return cur;
}
const SEED = nextSeed();

// ----------------------------------------------------------------------------
// pretty output + check tracking
// ----------------------------------------------------------------------------
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function group(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`);
}

function ok(label: string, detail?: string): void {
  passed++;
  console.log(`  ${GREEN}✅${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
}

function fail(label: string, detail?: string): void {
  failed++;
  failures.push(label);
  console.log(`  ${RED}❌${RESET} ${label}${detail ? `\n       ${RED}${detail}${RESET}` : ""}`);
}

// Assert a boolean; returns the boolean so callers can branch.
function check(cond: boolean, label: string, detail?: string): boolean {
  if (cond) ok(label, detail);
  else fail(label, detail);
  return cond;
}

function info(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`);
}

// ----------------------------------------------------------------------------
// http helper — never throws on non-2xx; returns status + parsed body + text
// ----------------------------------------------------------------------------
interface Res {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
  ok: boolean;
}

async function req(
  method: string,
  path: string,
  opts: { token?: string; json?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let bodyInit: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    bodyInit = JSON.stringify(opts.json);
  }
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const r = await fetch(url, { method, headers, body: bodyInit });
  const text = await r.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: r.status, body, text, ok: r.status >= 200 && r.status < 300 };
}

// short snippet of a response body for failure messages
function snippet(r: Res): string {
  const s = r.text.length > 240 ? r.text.slice(0, 240) + "…" : r.text;
  return `HTTP ${r.status} ${s}`;
}

// ----------------------------------------------------------------------------
// dependency-free JPEG generator
//   - sniffs as "jpeg" (FF D8 FF, ≥12 bytes) per packages/contracts/mediaSniff
//   - no EXIF needed: the worker's "media-library" tier validates against the
//     deviceCapturedAt=now we send at init.
//   - each call produces unique trailing bytes so two media in one run differ.
// ----------------------------------------------------------------------------
function makeJpeg(salt: number): Buffer {
  // Minimal JFIF APP0 header so it looks like a real JPEG opener, then a small
  // deterministic-but-salted payload, then EOI. Length comfortably ≥ 12.
  const head = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, // APP0
    0x00, 0x10, // length 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version 1.1
    0x00, // units
    0x00, 0x01, 0x00, 0x01, // density 1x1
    0x00, 0x00, // thumb 0x0
  ]);
  const payload = Buffer.alloc(32);
  for (let i = 0; i < payload.length; i++) payload[i] = (salt + i * 31) & 0xff;
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([head, payload, eoi]);
}

// ----------------------------------------------------------------------------
// auth: dev OTP login (phone). returns { token, userId } or throws.
// ----------------------------------------------------------------------------
async function devLogin(phone: string): Promise<{ token: string; userId: string }> {
  const start = await req("POST", "/auth/start", { json: { identifier: phone, channel: "phone" } });
  if (start.status === 429) {
    throw new Error(
      `/auth/start → 429 RATE_LIMITED. The per-IP OTP cap (OTP_MAX_PER_IP, default 20 / OTP_WINDOW_SEC, default 900s) ` +
        `is exhausted — you've run the smoke many times in 15min. Wait for the window to reset, or raise OTP_MAX_PER_IP in .env and restart the API.`,
    );
  }
  if (start.status !== 202) throw new Error(`/auth/start → ${snippet(start)}`);
  const otp = await req("GET", `/auth/dev/last-otp?identifier=${encodeURIComponent(phone)}`);
  const code = otp.body?.code as string | undefined;
  if (!code) throw new Error(`/auth/dev/last-otp returned no code → ${snippet(otp)}`);
  const verify = await req("POST", "/auth/verify", { json: { identifier: phone, channel: "phone", code } });
  if (verify.status !== 200 || !verify.body?.token) throw new Error(`/auth/verify → ${snippet(verify)}`);
  return { token: verify.body.token as string, userId: verify.body.userId as string };
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`${BOLD}twenty4 smoke test${RESET} → ${API}  ${DIM}(seed ${SEED})${RESET}`);

  // unique-per-run identifiers derived from seed (avoids Date.now/Math.random)
  const ownerPhone = `+1${String(SEED).padStart(10, "5")}`;
  const joinerPhone = `+1${String(SEED + 1).padStart(10, "5")}`;
  const strangerPhone = `+1${String(SEED + 2).padStart(10, "5")}`;

  // resources to clean up (best-effort, reverse order)
  const cleanup: Array<() => Promise<void>> = [];

  // tokens we may obtain; used across milestones
  let ownerToken: string | undefined;
  let joinerToken: string | undefined;
  let strangerToken: string | undefined;
  let groupId: string | undefined;
  let mediaId: string | undefined;

  // =====================================================================
  // M0 / M1 — API up + error envelope + content-type fix
  // =====================================================================
  group("M0/M1 — API health, error envelope, content-type");
  {
    const health = await req("GET", "/health");
    check(
      health.status === 200 && health.body?.status === "ok",
      "GET /health → 200 {status:ok}",
      health.status === 200 ? undefined : snippet(health),
    );

    const healthz = await req("GET", "/healthz");
    check(
      healthz.status === 200 && healthz.body?.db === "up",
      "GET /healthz → 200 {db:up}",
      healthz.status === 200 ? undefined : snippet(healthz),
    );

    const missing = await req("GET", "/does-not-exist");
    const env = missing.body?.error;
    check(
      missing.status === 404 &&
        env &&
        typeof env.code === "string" &&
        typeof env.status === "number" &&
        typeof env.message === "string",
      "GET /does-not-exist → 404 {error:{code,status,message}} envelope",
      missing.status === 404 && env ? undefined : snippet(missing),
    );

    // M1 fix: a body with a non-JSON content-type must NOT 415.
    // Use a raw fetch so we genuinely send octet-stream bytes (the req() helper
    // only attaches a body when given JSON).
    const echoRaw = await fetch(`${API}/_echo`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "ping-bytes",
    });
    const echoText = await echoRaw.text();
    check(
      echoRaw.status === 200,
      "POST /_echo (application/octet-stream) → 200, NOT 415 (M1 fix)",
      echoRaw.status === 200 ? undefined : `HTTP ${echoRaw.status} ${echoText.slice(0, 120)}`,
    );
  }

  // =====================================================================
  // M2 — Auth (dev OTP, guarded route)
  // =====================================================================
  group("M2 — Auth (dev OTP + guarded route)");
  try {
    // NOTE: we intentionally do NOT delete the throwaway users. /users/me delete
    // is a soft-delete (account → ACCOUNT_DELETED), which would permanently block
    // that phone from re-registering. Leaving them is harmless; a fresh seed each
    // run gives fresh users. We still delete the group + media we create below.
    const owner = await devLogin(ownerPhone);
    ownerToken = owner.token;
    ok("owner dev-OTP login (start → last-otp → verify)", `userId=${owner.userId.slice(0, 8)}…`);

    const joiner = await devLogin(joinerPhone);
    joinerToken = joiner.token;
    ok("joiner dev-OTP login", `userId=${joiner.userId.slice(0, 8)}…`);

    // guarded route WITH token → 200
    const meAuthed = await req("GET", "/users/me", { token: ownerToken });
    check(meAuthed.status === 200 && !!meAuthed.body?.id, "GET /users/me WITH token → 200", meAuthed.status === 200 ? undefined : snippet(meAuthed));

    // guarded route WITHOUT token → 401
    const meAnon = await req("GET", "/users/me");
    check(meAnon.status === 401, "GET /users/me WITHOUT token → 401", meAnon.status === 401 ? undefined : snippet(meAnon));
  } catch (e) {
    fail("M2 auth flow", (e as Error).message);
  }

  // =====================================================================
  // M3 — Groups (create → invite → preview → join → list → non-member 403)
  // =====================================================================
  group("M3 — Groups (create, invite, join, membership guard)");
  if (ownerToken && joinerToken) {
    try {
      // owner creates a group
      const created = await req("POST", "/groups", { token: ownerToken, json: { name: `smoke-${SEED}` } });
      if (check(created.status === 201 && !!created.body?.id, "owner POST /groups → 201 (group created)", created.status === 201 ? undefined : snippet(created))) {
        groupId = created.body.id as string;
        cleanup.push(async () => {
          await req("DELETE", `/groups/${groupId}`, { token: ownerToken });
        });
      }

      if (groupId) {
        // owner creates an invite
        const inv = await req("POST", `/groups/${groupId}/invites`, { token: ownerToken, json: {} });
        const code = inv.body?.code as string | undefined;
        check(inv.status === 201 && !!code, "owner POST /groups/:id/invites → 201 (code issued)", inv.status === 201 ? undefined : snippet(inv));

        if (code) {
          // joiner previews — should see no membership yet
          const preview = await req("GET", `/invites/${code}`, { token: joinerToken });
          check(
            preview.status === 200 && preview.body?.alreadyMember === false,
            "joiner GET /invites/:code preview → 200, alreadyMember=false",
            preview.status === 200 ? undefined : snippet(preview),
          );

          // joiner joins
          const join = await req("POST", `/invites/${code}/join`, { token: joinerToken });
          check(
            join.status === 200 && join.body?.status === "active",
            "joiner POST /invites/:code/join → 200, status=active",
            join.status === 200 ? undefined : snippet(join),
          );

          // joiner lists groups — must include the group
          const list = await req("GET", "/groups", { token: joinerToken });
          const listed = Array.isArray(list.body) && list.body.some((g: { id: string }) => g.id === groupId);
          check(list.status === 200 && listed, "joiner GET /groups lists the joined group", list.status === 200 ? (listed ? undefined : "group not in list") : snippet(list));
        }

        // a third identity (non-member) hitting the group → 403 NOT_A_MEMBER
        const stranger = await devLogin(strangerPhone);
        strangerToken = stranger.token;
        const forbidden = await req("GET", `/groups/${groupId}`, { token: strangerToken });
        check(
          forbidden.status === 403 && forbidden.body?.error?.code === "NOT_A_MEMBER",
          "non-member GET /groups/:id → 403 NOT_A_MEMBER",
          forbidden.status === 403 ? undefined : snippet(forbidden),
        );
      }
    } catch (e) {
      fail("M3 groups flow", (e as Error).message);
    }
  } else {
    fail("M3 groups flow", "skipped — auth (M2) did not produce tokens");
  }

  // =====================================================================
  // M4 — Storage / upload round-trip (init → PUT → complete → validate → DL)
  // =====================================================================
  group("M4 — Storage upload round-trip");
  if (ownerToken) {
    let workerStalled = false;
    try {
      const bytes = makeJpeg(SEED & 0xff);
      const contentType = "image/jpeg";

      // 1. init — media-library tier: deviceCapturedAt=now so no EXIF needed.
      const init = await req("POST", "/media", {
        token: ownerToken,
        json: {
          mediaType: "photo",
          contentType,
          byteSize: bytes.length,
          deviceTimezone: "UTC",
          deviceCapturedAt: new Date().toISOString(),
        },
      });
      const uploadUrl = init.body?.uploadUrl as string | undefined;
      if (check(init.status === 201 && !!uploadUrl && !!init.body?.id, "POST /media init → 201 (presigned uploadUrl)", init.status === 201 ? undefined : snippet(init))) {
        mediaId = init.body.id as string;
        cleanup.push(async () => {
          await req("DELETE", `/media/${mediaId}`, { token: ownerToken });
        });
      }

      if (uploadUrl) {
        // presigned URL host must be the PUBLIC endpoint, not localhost
        const host = new URL(uploadUrl).host;
        check(
          !host.startsWith("localhost") && !host.startsWith("127.0.0.1"),
          "presigned uploadUrl host is the public endpoint (not localhost)",
          host.startsWith("localhost") || host.startsWith("127.0.0.1") ? `host=${host} — set S3_PUBLIC_ENDPOINT to the LAN/Tailscale host` : `host=${host}`,
        );

        // 2. real PUT of the bytes (content-type must match what we signed at init)
        const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: bytes });
        await put.arrayBuffer().catch(() => undefined);
        check(put.status === 200, "presigned PUT uploads the bytes → 200", put.status === 200 ? undefined : `HTTP ${put.status}`);

        if (mediaId && put.status === 200) {
          // 3. complete
          const comp = await req("POST", `/media/${mediaId}/complete`, { token: ownerToken });
          check(comp.status === 200, "POST /media/:id/complete → 200", comp.status === 200 ? undefined : snippet(comp));

          // 4. poll /media/today until validationStatus is terminal (valid/invalid)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let item: any;
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const today = await req("GET", `/media/today?tz=UTC`, { token: ownerToken });
            item = Array.isArray(today.body?.items)
              ? today.body.items.find((it: { id: string }) => it.id === mediaId)
              : undefined;
            if (item && item.validationStatus !== "pending") break;
            await new Promise((r) => setTimeout(r, 1000));
          }

          if (!item || item.validationStatus === "pending") {
            workerStalled = true;
            fail(
              "media validation reaches terminal state",
              "still 'pending' after 30s — is the worker running?  start it with:  bun services/worker/src/index.ts",
            );
          } else {
            check(
              item.validationStatus === "valid",
              "media validation → valid",
              item.validationStatus === "valid" ? undefined : `validationStatus=${item.validationStatus} processing=${item.processingStatus}`,
            );
          }

          // 5. download-url + real GET + byte-compare (only if validation passed)
          if (!workerStalled && item?.validationStatus === "valid") {
            const dl = await req("GET", `/media/${mediaId}/download-url`, { token: ownerToken });
            const downloadUrl = dl.body?.downloadUrl as string | undefined;
            if (check(dl.status === 200 && !!downloadUrl, "GET /media/:id/download-url → 200", dl.status === 200 ? undefined : snippet(dl)) && downloadUrl) {
              const dlHost = new URL(downloadUrl).host;
              check(
                !dlHost.startsWith("localhost") && !dlHost.startsWith("127.0.0.1"),
                "download-url host is the public endpoint (not localhost)",
                dlHost.startsWith("localhost") ? `host=${dlHost}` : `host=${dlHost}`,
              );
              const got = await fetch(downloadUrl);
              const back = Buffer.from(await got.arrayBuffer());
              const match = back.length === bytes.length && Buffer.compare(back, bytes) === 0;
              check(match, "downloaded bytes byte-match the upload", match ? `${back.length} bytes` : `got ${back.length}, expected ${bytes.length}`);
            }
          } else if (workerStalled) {
            info("skipping download-url + byte-compare (validation never completed)");
          }
        }
      }
    } catch (e) {
      fail("M4 media flow", (e as Error).message);
    }
  } else {
    fail("M4 media flow", "skipped — auth (M2) did not produce an owner token");
  }

  // =====================================================================
  // cleanup (best-effort, reverse order)
  // =====================================================================
  group("cleanup");
  let cleaned = 0;
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
      cleaned++;
    } catch {
      // best-effort: ignore
    }
  }
  info(`best-effort cleanup ran ${cleaned}/${cleanup.length} deletions (media + group; throwaway users are left behind by design)`);

  // =====================================================================
  // summary
  // =====================================================================
  const total = passed + failed;
  console.log("");
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}M0–M4: ${passed}/${total} checks passed ✅${RESET}`);
  } else {
    console.log(`${RED}${BOLD}M0–M4: ${passed}/${total} passed, ${failed} FAILED ❌${RESET}`);
    for (const f of failures) console.log(`  ${RED}- ${f}${RESET}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${RED}smoke test crashed:${RESET}`, (err as Error).message ?? err);
  process.exit(1);
});
