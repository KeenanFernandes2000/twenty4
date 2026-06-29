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

describe("media endpoints", () => {
  it("mediaInit POSTs /media with auth + body and parses MediaInitRes", async () => {
    const stub = stubFetch(makeResponse(201, validMediaInitRes()));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const body = {
      mediaType: "photo" as const,
      contentType: "image/jpeg",
      byteSize: 1024,
      deviceTimezone: "America/New_York",
    };
    const res = await client.mediaInit(body);
    expect(stub.calls[0]!.url).toBe(`${BASE}/media`);
    expect(stub.calls[0]!.init.method).toBe("POST");
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(stub.calls[0]!.init.body).toBe(JSON.stringify(body));
    expect(res.id).toBe(MEDIA_ID);
    expect(res.uploadUrl).toContain("http");
    expect(res.storageKey).toBeTruthy();
  });

  it("mediaComplete POSTs /media/:id/complete (no body) with auth and parses MediaItemDTO", async () => {
    const stub = stubFetch(makeResponse(200, validMediaItem()));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const item = await client.mediaComplete(MEDIA_ID);
    expect(stub.calls[0]!.url).toBe(`${BASE}/media/${MEDIA_ID}/complete`);
    expect(stub.calls[0]!.init.method).toBe("POST");
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(stub.calls[0]!.init.body).toBeUndefined();
    expect(item.id).toBe(MEDIA_ID);
    expect(item.processingStatus).toBe("validating");
  });

  it("getMediaToday GETs /media/today with auth and parses MediaTodayRes", async () => {
    const stub = stubFetch(makeResponse(200, { dayBucket: "2026-06-25", items: [validMediaItem()] }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.getMediaToday();
    expect(stub.calls[0]!.url).toBe(`${BASE}/media/today`);
    expect(stub.calls[0]!.init.method).toBe("GET");
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(res.dayBucket).toBe("2026-06-25");
    expect(res.items.length).toBe(1);
    expect(res.items[0]!.id).toBe(MEDIA_ID);
  });

  it("getMediaDownloadUrl GETs /media/:id/download-url with auth and parses DownloadUrlRes", async () => {
    const stub = stubFetch(
      makeResponse(200, { id: MEDIA_ID, downloadUrl: "https://cdn.local/x.jpg", expiresInSec: 300 }),
    );
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.getMediaDownloadUrl(MEDIA_ID);
    expect(stub.calls[0]!.url).toBe(`${BASE}/media/${MEDIA_ID}/download-url`);
    expect(stub.calls[0]!.init.method).toBe("GET");
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(res.id).toBe(MEDIA_ID);
    expect(res.expiresInSec).toBe(300);
  });

  it("deleteMedia DELETEs /media/:id with auth and returns {status:'deleted'}", async () => {
    const stub = stubFetch(makeResponse(200, { status: "deleted" }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.deleteMedia(MEDIA_ID);
    expect(stub.calls[0]!.url).toBe(`${BASE}/media/${MEDIA_ID}`);
    expect(stub.calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(res.status).toBe("deleted");
  });

  it("trips the drift-guard when getMediaToday body is malformed", async () => {
    const bad = { dayBucket: "2026-06-25", items: [{ id: MEDIA_ID }] }; // item missing required fields
    stubFetch(makeResponse(200, bad));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    let thrown: unknown;
    try {
      await client.getMediaToday();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ApiError);
    expect((thrown as Error).message).toContain("failed validation");
  });
});

describe("feed + social endpoints", () => {
  it("getFeed GETs /feed with auth + group/cursor query and parses FeedPage", async () => {
    const stub = stubFetch(makeResponse(200, validFeedPage()));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const page = await client.getFeed({ group: GROUP_ID, cursor: "c1" });
    expect(stub.calls[0]!.url).toBe(`${BASE}/feed?group=${GROUP_ID}&cursor=c1`);
    expect(stub.calls[0]!.init.method).toBe("GET");
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(page.items[0]!.montageId).toBe(MONTAGE_ID);
    expect(page.nextCursor).toBe("next");
  });

  it("getFeed with no opts GETs bare /feed", async () => {
    const stub = stubFetch(makeResponse(200, { items: [], nextCursor: null }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    await client.getFeed();
    expect(stub.calls[0]!.url).toBe(`${BASE}/feed`);
  });

  it("setReaction POSTs /montages/:id/reactions with {type} and parses ReactionSummary", async () => {
    const stub = stubFetch(makeResponse(200, { count: 1, viewerReaction: "fire" }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.setReaction(MONTAGE_ID, "fire");
    expect(stub.calls[0]!.url).toBe(`${BASE}/montages/${MONTAGE_ID}/reactions`);
    expect(stub.calls[0]!.init.method).toBe("POST");
    expect(stub.calls[0]!.init.body).toBe(JSON.stringify({ type: "fire" }));
    expect(res.count).toBe(1);
    expect(res.viewerReaction).toBe("fire");
  });

  it("clearReaction DELETEs /montages/:id/reactions and parses ReactionSummary", async () => {
    const stub = stubFetch(makeResponse(200, { count: 0, viewerReaction: null }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.clearReaction(MONTAGE_ID);
    expect(stub.calls[0]!.url).toBe(`${BASE}/montages/${MONTAGE_ID}/reactions`);
    expect(stub.calls[0]!.init.method).toBe("DELETE");
    expect(res.count).toBe(0);
    expect(res.viewerReaction).toBeNull();
  });

  it("getComments GETs /montages/:id/comments with cursor and parses CommentsPage", async () => {
    const stub = stubFetch(makeResponse(200, { items: [validCommentDto()], nextCursor: null }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.getComments(MONTAGE_ID, "cur");
    expect(stub.calls[0]!.url).toBe(`${BASE}/montages/${MONTAGE_ID}/comments?cursor=cur`);
    expect(stub.calls[0]!.init.method).toBe("GET");
    expect(res.items[0]!.id).toBe(COMMENT_ID);
  });

  it("addComment POSTs /montages/:id/comments with {text} and parses AddCommentRes", async () => {
    const stub = stubFetch(makeResponse(201, { comment: validCommentDto(), commentCount: 1 }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.addComment(MONTAGE_ID, "hello");
    expect(stub.calls[0]!.url).toBe(`${BASE}/montages/${MONTAGE_ID}/comments`);
    expect(stub.calls[0]!.init.method).toBe("POST");
    expect(stub.calls[0]!.init.body).toBe(JSON.stringify({ text: "hello" }));
    expect(res.comment.id).toBe(COMMENT_ID);
    expect(res.commentCount).toBe(1);
  });

  it("deleteComment DELETEs /comments/:id and returns {commentCount}", async () => {
    const stub = stubFetch(makeResponse(200, { commentCount: 0 }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.deleteComment(COMMENT_ID);
    expect(stub.calls[0]!.url).toBe(`${BASE}/comments/${COMMENT_ID}`);
    expect(stub.calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(res.commentCount).toBe(0);
  });

  it("trips the drift-guard when a feed card is malformed", async () => {
    const bad = validFeedPage() as { items: Array<Record<string, unknown>> };
    delete bad.items[0]!.reactionCount; // required by feedCardSchema
    stubFetch(makeResponse(200, bad));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    let thrown: unknown;
    try {
      await client.getFeed();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ApiError);
    expect((thrown as Error).message).toContain("failed validation");
  });
});

describe("ephemerality + admin endpoints (M9)", () => {
  it("replaceMontage POSTs /montages/:id/replace and parses ReplaceMontageRes", async () => {
    const stub = stubFetch(makeResponse(202, { montageId: GROUP_ID, status: "generating" }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.replaceMontage(MONTAGE_ID, { theme: "party" });
    expect(stub.calls[0]!.url).toBe(`${BASE}/montages/${MONTAGE_ID}/replace`);
    expect(stub.calls[0]!.init.method).toBe("POST");
    expect(stub.calls[0]!.init.body).toBe(JSON.stringify({ theme: "party" }));
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(res.montageId).toBe(GROUP_ID);
    expect(res.status).toBe("generating");
  });

  it("deleteMontage DELETEs /montages/:id and returns {status:'deleting'}", async () => {
    const stub = stubFetch(makeResponse(202, { status: "deleting" }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.deleteMontage(MONTAGE_ID);
    expect(stub.calls[0]!.url).toBe(`${BASE}/montages/${MONTAGE_ID}`);
    expect(stub.calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(res.status).toBe("deleting");
  });

  it("getMontageDownloadUrl GETs /montages/:id/download-url and parses DownloadUrlRes", async () => {
    const stub = stubFetch(makeResponse(200, { id: MONTAGE_ID, downloadUrl: "https://cdn.local/v.mp4", expiresInSec: 120 }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.getMontageDownloadUrl(MONTAGE_ID);
    expect(stub.calls[0]!.url).toBe(`${BASE}/montages/${MONTAGE_ID}/download-url`);
    expect(stub.calls[0]!.init.method).toBe("GET");
    expect(res.id).toBe(MONTAGE_ID);
    expect(res.expiresInSec).toBe(120);
  });

  it("deleteAccount DELETEs /users/me and returns {status:'deleted'}", async () => {
    const stub = stubFetch(makeResponse(200, { status: "deleted" }));
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.deleteAccount();
    expect(stub.calls[0]!.url).toBe(`${BASE}/users/me`);
    expect(stub.calls[0]!.init.method).toBe("DELETE");
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(res.status).toBe("deleted");
  });

  it("getCleanupJobs GETs /admin/cleanup-jobs and parses CleanupJobsRes", async () => {
    const stub = stubFetch(
      makeResponse(200, {
        queues: [{ queue: "expire-montage", failed: 0, delayed: 2, jobs: [] }],
      }),
    );
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.getCleanupJobs();
    expect(stub.calls[0]!.url).toBe(`${BASE}/admin/cleanup-jobs`);
    expect(headerOf(stub.calls[0]!.init, "authorization")).toBe("Bearer t");
    expect(res.queues[0]!.queue).toBe("expire-montage");
    expect(res.queues[0]!.delayed).toBe(2);
  });

  it("getStorageUsage GETs /admin/storage-usage and parses StorageUsageRes", async () => {
    const stub = stubFetch(
      makeResponse(200, { liveMontages: 5, publishedMontages: 3, rawMediaItems: 9, reactions: 4, comments: 2 }),
    );
    const client = createApiClient({ baseUrl: BASE, getToken: () => "t" });
    const res = await client.getStorageUsage();
    expect(stub.calls[0]!.url).toBe(`${BASE}/admin/storage-usage`);
    expect(res.publishedMontages).toBe(3);
    expect(res.reactions).toBe(4);
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
const MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const MONTAGE_ID = "44444444-4444-4444-8444-444444444444";
const COMMENT_ID = "55555555-5555-4555-8555-555555555555";

function validCommentDto() {
  return {
    id: COMMENT_ID,
    montageId: MONTAGE_ID,
    author: { id: USER_ID, displayName: "Ada", avatarUrl: null },
    text: "hello",
    createdAt: "2026-06-26T00:00:00.000Z",
    canDelete: true,
  };
}

function validFeedPage() {
  return {
    items: [
      {
        montageId: MONTAGE_ID,
        author: { id: USER_ID, displayName: "Ada", avatarUrl: "https://cdn.local/a.jpg" },
        dayBucket: "2026-06-26",
        expiryAt: "2026-06-27T00:00:00.000Z",
        durationMs: 30000,
        videoUrl: "https://cdn.local/v.mp4?sig=abc",
        thumbnailUrl: "https://cdn.local/t.jpg?sig=abc",
        reactionCount: 0,
        viewerReaction: null,
        commentCount: 0,
        commentPreview: [],
        canDelete: false,
        canReport: true,
      },
    ],
    nextCursor: "next",
  };
}

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

function validMediaInitRes() {
  return {
    id: MEDIA_ID,
    uploadUrl: "https://storage.local/raw/x?sig=abc",
    storageKey: "raw/2026-06-25/x",
  };
}

function validMediaItem() {
  return {
    id: MEDIA_ID,
    mediaType: "photo",
    dayBucket: "2026-06-25",
    validationStatus: "pending",
    processingStatus: "validating",
    originalTimestamp: null,
    durationMs: null,
    uploadTimestamp: "2026-06-25T00:00:00.000Z",
    downloadUrl: null,
    // M7 §12: MediaItemDTO now carries a nullable video-poster URL (null for photos).
    thumbnailUrl: null,
    metadataSummary: {},
  };
}
