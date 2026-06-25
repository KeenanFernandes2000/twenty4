// Unit tests for @twenty4/api-client — mocked-fetch coverage of the request
// pipeline: error-envelope parsing, 401 → onUnauthorized, Bearer injection, and
// success-response validation (drift guard). Runs under `bun test`.
//
// We stub the GLOBAL fetch per test and restore it after, capturing the
// (url, init) the client produced so we can assert on headers/method/body.

import { afterEach, describe, expect, it } from "bun:test";
import { ApiError, createApiClient } from "../src/index.ts";

const BASE = "http://test.local:3000";

// A minimal Response-like stub matching what the client reads: .ok, .status, .text().
function makeResponse(status: number, body: unknown): Response {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
  } as unknown as Response;
}

interface Captured {
  url: string;
  init: RequestInit;
}

// Install a fetch stub that records the call and returns the given response.
// Returns the capture box (mutated on call) so tests can assert afterwards.
function stubFetch(response: Response | (() => Response)): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
  return { calls };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function headerOf(init: RequestInit, name: string): string | undefined {
  const h = (init.headers ?? {}) as Record<string, string>;
  // headers are plain objects in this client; do a case-insensitive lookup.
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

describe("error envelope parsing", () => {
  it("parses a 422 VALIDATION_FAILED envelope into a typed ApiError", async () => {
    stubFetch(
      makeResponse(422, {
        error: { code: "VALIDATION_FAILED", status: 422, message: "identifier is required" },
      }),
    );
    const client = createApiClient({ baseUrl: BASE });
    let thrown: unknown;
    try {
      await client.authStart({ identifier: "+15550000000", channel: "phone" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const err = thrown as ApiError;
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.status).toBe(422);
    expect(err.message).toBe("identifier is required");
    expect(err.envelope?.error.code).toBe("VALIDATION_FAILED");
  });

  it("degrades a non-envelope 500 body to ApiError code INTERNAL with the HTTP status", async () => {
    stubFetch(makeResponse(500, "<html>internal server error</html>"));
    const client = createApiClient({ baseUrl: BASE });
    let thrown: unknown;
    try {
      await client.health();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const err = thrown as ApiError;
    expect(err.code).toBe("INTERNAL");
    expect(err.status).toBe(500);
    expect(err.envelope).toBeNull();
  });
});

describe("401 → onUnauthorized hook", () => {
  it("calls onUnauthorized AND throws ApiError UNAUTHORIZED on a 401 envelope", async () => {
    stubFetch(
      makeResponse(401, { error: { code: "UNAUTHORIZED", status: 401, message: "session expired" } }),
    );
    let hookCalls = 0;
    const client = createApiClient({
      baseUrl: BASE,
      getToken: () => "stale-token",
      onUnauthorized: () => {
        hookCalls++;
      },
    });
    let thrown: unknown;
    try {
      await client.getMe();
    } catch (e) {
      thrown = e;
    }
    expect(hookCalls).toBe(1);
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe("UNAUTHORIZED");
    expect((thrown as ApiError).status).toBe(401);
  });

  it("still fires onUnauthorized on a raw (non-envelope) 401 body", async () => {
    stubFetch(makeResponse(401, "Unauthorized"));
    let hookCalls = 0;
    const client = createApiClient({ baseUrl: BASE, onUnauthorized: () => hookCalls++ });
    await client.getMe().catch(() => undefined);
    expect(hookCalls).toBe(1);
  });
});

describe("Bearer injection", () => {
  it("injects Authorization: Bearer <token> on an authed method", async () => {
    const stub = stubFetch(makeResponse(200, validUser()));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "tok123" });
    await client.getMe();
    expect(stub.calls.length).toBe(1);
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer tok123");
  });

  it("awaits an async getToken", async () => {
    const stub = stubFetch(makeResponse(200, validUser()));
    const client = createApiClient({ baseUrl: BASE, getToken: async () => "async-tok" });
    await client.getMe();
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer async-tok");
  });

  it("sends NO auth header on an unauthed method (authStart)", async () => {
    const stub = stubFetch(makeResponse(202, { status: "sent", channel: "phone" }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "tok123" });
    await client.authStart({ identifier: "+15550000000", channel: "phone" });
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBeUndefined();
  });

  it("sends no auth header when getToken returns null", async () => {
    const stub = stubFetch(makeResponse(200, validUser()));
    const client = createApiClient({ baseUrl: BASE, getToken: () => null });
    await client.getMe();
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBeUndefined();
  });
});

describe("request building", () => {
  it("sets content-type and JSON-stringifies the body on a POST", async () => {
    const stub = stubFetch(makeResponse(201, validGroup()));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    await client.createGroup({ name: "weekend crew" });
    const init = stub.calls[0]!.init;
    expect(init.method).toBe("POST");
    expect(headerOf(init, "content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "weekend crew" }));
  });

  it("appends query params (dev/last-otp) and URL-encodes them", async () => {
    const stub = stubFetch(makeResponse(200, { identifier: "+15550000001", code: "123456" }));
    const client = createApiClient({ baseUrl: BASE });
    await client.getDevLastOtp("+15550000001", "phone");
    expect(stub.calls[0]!.url).toBe(
      `${BASE}/auth/dev/last-otp?identifier=%2B15550000001&channel=phone`,
    );
  });
});

describe("success response validation (drift guard)", () => {
  it("getMe returns a typed UserDTO for a valid body", async () => {
    stubFetch(makeResponse(200, validUser()));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const me = await client.getMe();
    expect(me.id).toBe(USER_ID);
    expect(me.accountStatus).toBe("active");
    expect(me.isAdmin).toBe(false);
  });

  it("throws (NOT an ApiError) when getMe body is missing a required field", async () => {
    const bad = validUser() as Record<string, unknown>;
    delete bad.accountStatus; // required by userDtoSchema
    stubFetch(makeResponse(200, bad));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    let thrown: unknown;
    try {
      await client.getMe();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ApiError);
    expect((thrown as Error).message).toContain("failed validation");
  });

  it("listGroups validates an array of GroupDTO", async () => {
    stubFetch(makeResponse(200, [validGroup(), validGroup()]));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const groups = await client.listGroups();
    expect(groups.length).toBe(2);
    expect(groups[0]!.role).toBe("owner");
  });
});

describe("missing baseUrl guard", () => {
  it("does NOT throw at construction, but rejects at request time with a clear ApiError", async () => {
    const prev = process.env.EXPO_PUBLIC_API_URL;
    delete process.env.EXPO_PUBLIC_API_URL;
    try {
      // Construction must be side-effect safe (no throw) even with no URL.
      const client = createApiClient();
      let thrown: unknown;
      try {
        await client.health();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      const err = thrown as ApiError;
      expect(err.code).toBe("INTERNAL");
      expect(err.message).toMatch(/API base URL is not configured/);
    } finally {
      if (prev !== undefined) process.env.EXPO_PUBLIC_API_URL = prev;
    }
  });

  it("strips a trailing slash from baseUrl", async () => {
    const stub = stubFetch(makeResponse(200, { status: "ok" }));
    const client = createApiClient({ baseUrl: `${BASE}/` });
    await client.health();
    expect(stub.calls[0]!.url).toBe(`${BASE}/health`);
  });
});

// ── fixtures ─────────────────────────────────────────────────────────────────
// Valid RFC-4122 v4 UUIDs (version nibble 4, variant nibble 8/9/a/b) — zod 4's
// .uuid() rejects the lazy all-same-digit form.
const USER_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";

function validUser() {
  return {
    id: USER_ID,
    displayName: "Ada",
    username: "ada",
    email: null,
    phone: "+15550000000",
    profilePhotoUrl: null,
    authProvider: "phone",
    accountStatus: "active",
    isAdmin: false,
    createdAt: "2026-06-25T00:00:00.000Z",
  };
}

function validGroup() {
  return {
    id: GROUP_ID,
    name: "weekend crew",
    photoUrl: null,
    ownerId: USER_ID,
    status: "active",
    role: "owner",
    memberCount: 1,
    createdAt: "2026-06-25T00:00:00.000Z",
  };
}
