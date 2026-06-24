#!/usr/bin/env bun
// M4 throwaway device-upload harness (§3.10 / §8 acceptance).
//
// Runs the full transport end-to-end against a LIVE backend:
//   init → presigned PUT → complete → poll /media/today → signed GET → byte-compare
//
// Designed to run from the dev laptop OR a real Android phone (Termux + Bun) over
// LAN/Tailscale — it only needs `fetch` + the file bytes, so no native modules.
// The Expo screen for this is M6's job; this proves the pipeline before M6.
//
// USAGE:
//   bun scripts/device-upload-harness.ts <photo|video> <path-to-media-file> \
//       [--api http://100.98.100.117:3000] [--token <bearer>] [--phone +1555...]
//
// AUTH: pass a --token (bearer) you already have, OR a --phone to drive the dev
// OTP login flow (start → dev/last-otp → verify) against a dev backend.
//
// Examples:
//   # photo, auth via dev phone OTP:
//   bun scripts/device-upload-harness.ts photo ~/pic.jpg --phone +15551230000
//   # video, with an existing bearer token:
//   bun scripts/device-upload-harness.ts video ~/clip.mp4 --token eyJ...
import { readFileSync } from "node:fs";
import { basename } from "node:path";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mediaType = process.argv[2] as "photo" | "video";
const filePath = process.argv[3];
const API = arg("--api") ?? process.env.EXPO_PUBLIC_API_URL ?? "http://100.98.100.117:3000";
let token = arg("--token");
const phone = arg("--phone");

if (!["photo", "video"].includes(mediaType) || !filePath) {
  console.error("usage: bun scripts/device-upload-harness.ts <photo|video> <file> [--api URL] [--token T | --phone +1...]");
  process.exit(1);
}

// Guess a content-type from the extension.
function contentTypeFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    heic: "image/heic",
    mp4: "video/mp4",
    mov: "video/quicktime",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

async function devLogin(): Promise<string> {
  console.log(`[auth] dev OTP login for ${phone} ...`);
  const start = await fetch(`${API}/auth/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: phone, channel: "phone" }),
  });
  if (start.status !== 202) throw new Error(`/auth/start ${start.status}: ${await start.text()}`);
  const otp = await fetch(`${API}/auth/dev/last-otp?identifier=${encodeURIComponent(phone!)}`);
  const code = (await otp.json()).code as string;
  const verify = await fetch(`${API}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: phone, channel: "phone", code }),
  });
  if (verify.status !== 200) throw new Error(`/auth/verify ${verify.status}: ${await verify.text()}`);
  return (await verify.json()).token as string;
}

async function main() {
  if (!token) {
    if (!phone) throw new Error("provide --token or --phone");
    token = await devLogin();
  }
  const auth = { authorization: `Bearer ${token}` };
  const bytes = readFileSync(filePath);
  const contentType = contentTypeFor(filePath);
  console.log(`[harness] ${mediaType} ${basename(filePath)} (${bytes.length} bytes, ${contentType}) → ${API}`);

  // 1. init
  const initRes = await fetch(`${API}/media`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({
      mediaType,
      contentType,
      byteSize: bytes.length,
      deviceTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deviceCapturedAt: new Date().toISOString(),
    }),
  });
  if (initRes.status !== 201) throw new Error(`init ${initRes.status}: ${await initRes.text()}`);
  const { id, uploadUrl, storageKey } = await initRes.json();
  console.log(`[1/5] init ok → id=${id} key=${storageKey}`);
  console.log(`       uploadUrl host = ${new URL(uploadUrl).host}`);

  // 2. presigned PUT
  const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: bytes });
  if (put.status !== 200) throw new Error(`PUT ${put.status}: ${await put.text()}`);
  console.log(`[2/5] presigned PUT ok (${put.status})`);

  // 3. complete
  const comp = await fetch(`${API}/media/${id}/complete`, { method: "POST", headers: auth });
  if (comp.status !== 200) throw new Error(`complete ${comp.status}: ${await comp.text()}`);
  console.log(`[3/5] complete ok → processingStatus=${(await comp.json()).processingStatus}`);

  // 4. poll /media/today until validation_status leaves "pending"
  let item: { validationStatus: string; processingStatus: string; downloadUrl: string | null } | undefined;
  for (let i = 0; i < 30; i++) {
    const today = await fetch(
      `${API}/media/today?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
      { headers: auth },
    );
    const body = await today.json();
    item = body.items.find((it: { id: string }) => it.id === id);
    if (item && item.validationStatus !== "pending") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!item) throw new Error("item never appeared in /media/today");
  console.log(`[4/5] poll → validation=${item.validationStatus} processing=${item.processingStatus}`);

  // 5. signed GET + byte compare
  const dlRes = await fetch(`${API}/media/${id}/download-url`, { headers: auth });
  if (dlRes.status !== 200) throw new Error(`download-url ${dlRes.status}: ${await dlRes.text()}`);
  const { downloadUrl } = await dlRes.json();
  console.log(`       downloadUrl host = ${new URL(downloadUrl).host}`);
  const got = await fetch(downloadUrl);
  const back = Buffer.from(await got.arrayBuffer());
  const match = back.length === bytes.length && Buffer.compare(back, bytes) === 0;
  console.log(`[5/5] signed GET ok (${back.length} bytes) — byte-match: ${match ? "YES ✓" : "NO ✗"}`);

  if (!match) process.exit(2);
  console.log(`\n✅ round-trip complete for ${mediaType} (validation=${item.validationStatus})`);
}

main().catch((err) => {
  console.error("HARNESS FAILED:", err.message ?? err);
  process.exit(1);
});
