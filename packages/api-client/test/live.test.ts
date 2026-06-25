// Live integration test for @twenty4/api-client — guarded.
//
// Exercises the real login dance against a running API (mirrors scripts/smoke.ts):
//   authStart → getDevLastOtp → authVerify → getMe → createGroup → listGroups.
//
// It is SKIPPED cleanly (so `bun test` stays green in CI/headless) unless the API
// at EXPO_PUBLIC_API_URL (or http://localhost:3000) answers GET /health with ok.
// We probe once at module load and gate the whole suite on the result.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createApiClient } from "../src/index.ts";

const BASE = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");

// Probe the API once; if it doesn't respond ok, the suite self-skips.
async function probe(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

// Unique-per-run phone identifier. Account deletion is a soft-delete (a phone can
// only register once), so derive a fresh number from pid + time. Date/random are
// fine in bun tests. 10 digits after the +1 country code.
function freshPhone(): string {
  const tail = `${process.pid}${Date.now()}`.slice(-10).padStart(10, "5");
  return `+1${tail}`;
}

const apiUp = await probe();

describe("live integration (skips if API down)", () => {
  if (!apiUp) {
    it.skip(`API not reachable at ${BASE}/health — skipping live happy-path`, () => {});
    // Log once so the skip reason is visible in the test output.
    // eslint-disable-next-line no-console
    console.log(`[live.test] API not reachable at ${BASE} — live test skipped (this is OK).`);
    return;
  }

  let token: string | null = null;
  const client = createApiClient({ baseUrl: BASE, getToken: () => token });

  beforeAll(() => {
    // eslint-disable-next-line no-console
    console.log(`[live.test] API up at ${BASE} — running live happy-path.`);
  });

  let createdGroupId: string | undefined;

  afterAll(async () => {
    // Best-effort cleanup of the group (we intentionally leave the throwaway
    // user — account delete is a soft-delete that permanently burns the phone).
    if (createdGroupId && token) {
      try {
        await client.deleteGroup(createdGroupId);
      } catch {
        /* best-effort */
      }
    }
  });

  it("authStart → dev OTP → authVerify → getMe → createGroup → listGroups", async () => {
    const phone = freshPhone();

    // 1. start: 202 {status:"sent",channel}
    const start = await client.authStart({ identifier: phone, channel: "phone" });
    expect(start.status).toBe("sent");
    expect(start.channel).toBe("phone");

    // 2. dev OTP
    const otp = await client.getDevLastOtp(phone, "phone");
    expect(otp.code).toBeTruthy();

    // 3. verify → SessionDTO; capture the bearer for subsequent authed calls.
    const session = await client.authVerify({ identifier: phone, channel: "phone", code: otp.code! });
    expect(session.token).toBeTruthy();
    expect(session.userId).toBeTruthy();
    token = session.token;

    // 4. getMe — session hydration, carries accountStatus.
    const me = await client.getMe();
    expect(me.id).toBe(session.userId);
    expect(me.accountStatus).toBe("active");

    // 5. createGroup → 201 GroupDTO (caller is owner).
    const group = await client.createGroup({ name: `apiclient-live-${process.pid}` });
    expect(group.id).toBeTruthy();
    expect(group.role).toBe("owner");
    expect(group.ownerId).toBe(session.userId);
    createdGroupId = group.id;

    // 6. listGroups — must include the just-created group.
    const groups = await client.listGroups();
    expect(groups.some((g) => g.id === group.id)).toBe(true);

    // 7. getMediaToday — a fresh user has no media → empty bucket. We exercise the
    //    JSON endpoint only (no binary PUT; that's the mobile e2e's job). Reuses
    //    the bearer captured above on the same client.
    const today = await client.getMediaToday();
    expect(typeof today.dayBucket).toBe("string");
    expect(Array.isArray(today.items)).toBe(true);
    expect(today.items.length).toBe(0);
  });
});
