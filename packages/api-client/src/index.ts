// @twenty4/api-client — the REAL typed fetch client for mobile (and later admin).
//
// Pure TypeScript: runs under React Native, Bun, and the browser. It uses ONLY
// the global `fetch` and depends only on @twenty4/contracts. There are NO Expo /
// React Native / Node imports here — keep it that way.
//
// Auth model (M2): POST /auth/verify returns a bearer token in the JSON body
// ({ token, userId, expiresAt }). Every authed request sends the header
// `Authorization: Bearer <token>`. No cookies. The app injects a `getToken`
// callback (and an `onUnauthorized` hook the client calls on any 401 so the app
// can clear its session) at construction.
//
// Errors: every non-2xx response is the contracts error envelope
// ({ error: { code, status, message } }). The client parses it into a typed
// `ApiError` (a real Error subclass) carrying `.code`, `.status`, `.message`,
// and the raw `.envelope`. A non-envelope error body degrades to code INTERNAL.

import { z } from "zod";
import {
  downloadUrlResSchema,
  errorEnvelopeSchema,
  groupDtoSchema,
  inviteDtoSchema,
  invitePreviewDtoSchema,
  joinResultDtoSchema,
  mediaInitResSchema,
  mediaItemDtoSchema,
  mediaTodayResSchema,
  memberDtoSchema,
  sessionDtoSchema,
  userDtoSchema,
} from "@twenty4/contracts";
import type {
  AuthRefreshReq,
  AuthStartReq,
  AuthVerifyReq,
  Channel,
  CreateGroupReq,
  CreateUserReq,
  DownloadUrlRes,
  ErrorCode,
  ErrorEnvelope,
  GroupDTO,
  InviteDTO,
  InvitePreviewDTO,
  JoinResultDTO,
  MediaInitReq,
  MediaInitRes,
  MediaItemDTO,
  MediaTodayRes,
  MemberDTO,
  PatchGroupReq,
  SessionDTO,
  UpdateMeReq,
  UserDTO,
} from "@twenty4/contracts";

// ── ApiError ─────────────────────────────────────────────────────────────────
// A real Error subclass carrying the typed taxonomy. `instanceof ApiError` works
// for callers to branch on transport vs. logic failures, and `.code` lets them
// switch on the specific error without string-matching the message.
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** The parsed wire envelope when the body was a valid one; otherwise null. */
  readonly envelope: ErrorEnvelope | null;

  constructor(code: ErrorCode, status: number, message: string, envelope: ErrorEnvelope | null = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.envelope = envelope;
    // Restore prototype chain (TS target ES2022 + extends Error).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Options ──────────────────────────────────────────────────────────────────
export interface ApiClientOptions {
  /**
   * Base URL of the API. MUST be the machine's LAN/Tailscale IP on a real device
   * (e.g. http://100.98.100.117:3000), never 127.0.0.1. Defaults to
   * `process.env.EXPO_PUBLIC_API_URL`. Construction NEVER throws if it's missing —
   * the check is deferred to request time (so `import { api }` stays side-effect
   * safe and the (auth) screens render); the first method call then rejects with a
   * clear ApiError (code INTERNAL) instead of white-screening the app.
   */
  baseUrl?: string;
  /**
   * Returns the current bearer token (or null when signed out). May be async.
   * Injected on every `auth:true` request as `Authorization: Bearer <token>`.
   */
  getToken?: () => string | null | Promise<string | null>;
  /**
   * Called once on any 401 UNAUTHORIZED response, BEFORE the ApiError is thrown,
   * so the app can clear its session / route to sign-in.
   */
  onUnauthorized?: () => void;
}

// Options for the internal request helper.
interface RequestOptions<T> {
  /** JSON body — stringified; sets content-type: application/json. */
  body?: unknown;
  /** Inject the bearer token (requires getToken). */
  auth?: boolean;
  /** Query params appended to the path (undefined/null values are skipped). */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Zod schema to validate+parse the success body against (drift guard). */
  schema?: z.ZodType<T>;
}

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

// ── Bare {status:"..."} response literal types ───────────────────────────────
type AuthStartRes = { status: "sent"; channel: Channel };
type LogoutRes = { status: "logged_out" };
type DeletedRes = { status: "deleted" };
type ArchivedRes = { status: "archived" };
type RevokedRes = { status: "revoked" };
type RemovedRes = { status: "removed" };
type LeftRes = { status: "left" };
type DevLastOtpRes = { identifier: string; code: string | null };

// Array schemas (the contracts export the element schemas; arrays we build here).
const groupArraySchema = z.array(groupDtoSchema);
const memberArraySchema = z.array(memberDtoSchema);

export function createApiClient(opts: ApiClientOptions = {}) {
  // Resolved lazily-checked at request time — construction NEVER throws on a
  // missing URL (keeps `import { api }` side-effect safe). May be undefined here.
  const baseUrl = (opts.baseUrl ?? process.env.EXPO_PUBLIC_API_URL)?.replace(/\/+$/, "");

  // Build a fully-qualified URL from a path + optional query params. Throws a
  // clear ApiError at call time when baseUrl was never configured.
  function buildUrl(path: string, query?: RequestOptions<unknown>["query"]): string {
    if (!baseUrl) {
      throw new ApiError(
        "INTERNAL",
        0,
        "API base URL is not configured (set EXPO_PUBLIC_API_URL).",
      );
    }
    let url = `${baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  // The core request pipeline. Throws ApiError on any non-2xx.
  async function request<T>(method: HttpMethod, path: string, options: RequestOptions<T> = {}): Promise<T> {
    const headers: Record<string, string> = {};

    let bodyInit: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      bodyInit = JSON.stringify(options.body);
    }

    if (options.auth) {
      const token = opts.getToken ? await opts.getToken() : null;
      if (token) headers.authorization = `Bearer ${token}`;
    }

    const res = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: bodyInit,
    });

    // Read the body text once; parse JSON best-effort (some 2xx are empty).
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!res.ok) {
      const envResult = errorEnvelopeSchema.safeParse(parsed);
      if (envResult.success) {
        const env = envResult.data;
        if (env.error.code === "UNAUTHORIZED") opts.onUnauthorized?.();
        throw new ApiError(env.error.code, env.error.status, env.error.message, env);
      }
      // Non-envelope error body — degrade to INTERNAL but keep the HTTP status.
      // Still fire onUnauthorized on a raw 401 so the app isn't stuck signed-in.
      if (res.status === 401) opts.onUnauthorized?.();
      throw new ApiError(
        "INTERNAL",
        res.status,
        `Request failed (HTTP ${res.status})`,
        null,
      );
    }

    // Success. Validate against the schema when one is supplied (drift guard).
    if (options.schema) {
      const result = options.schema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `API response failed validation for ${method} ${path}: ${result.error.message}`,
        );
      }
      return result.data;
    }
    return parsed as T;
  }

  return {
    // ── Health ──────────────────────────────────────────────────────────────
    health(): Promise<{ status: string }> {
      return request<{ status: string }>("GET", "/health");
    },

    // ── Auth ────────────────────────────────────────────────────────────────
    authStart(body: AuthStartReq): Promise<AuthStartRes> {
      return request<AuthStartRes>("POST", "/auth/start", { body });
    },
    authVerify(body: AuthVerifyReq): Promise<SessionDTO> {
      return request<SessionDTO>("POST", "/auth/verify", { body, schema: sessionDtoSchema });
    },
    authRefresh(body?: AuthRefreshReq): Promise<SessionDTO> {
      return request<SessionDTO>("POST", "/auth/refresh", { body: body ?? {}, auth: true, schema: sessionDtoSchema });
    },
    authLogout(): Promise<LogoutRes> {
      return request<LogoutRes>("POST", "/auth/logout", { auth: true });
    },
    getDevLastOtp(identifier: string, channel: Channel = "phone"): Promise<DevLastOtpRes> {
      return request<DevLastOtpRes>("GET", "/auth/dev/last-otp", { query: { identifier, channel } });
    },

    // ── Users ───────────────────────────────────────────────────────────────
    getMe(): Promise<UserDTO> {
      return request<UserDTO>("GET", "/users/me", { auth: true, schema: userDtoSchema });
    },
    createUser(body: CreateUserReq): Promise<UserDTO> {
      return request<UserDTO>("POST", "/users", { body, auth: true, schema: userDtoSchema });
    },
    updateMe(body: UpdateMeReq): Promise<UserDTO> {
      return request<UserDTO>("PATCH", "/users/me", { body, auth: true, schema: userDtoSchema });
    },
    deleteMe(): Promise<DeletedRes> {
      return request<DeletedRes>("DELETE", "/users/me", { auth: true });
    },

    // ── Groups ──────────────────────────────────────────────────────────────
    listGroups(): Promise<GroupDTO[]> {
      return request<GroupDTO[]>("GET", "/groups", { auth: true, schema: groupArraySchema });
    },
    createGroup(body: CreateGroupReq): Promise<GroupDTO> {
      return request<GroupDTO>("POST", "/groups", { body, auth: true, schema: groupDtoSchema });
    },
    getGroup(id: string): Promise<GroupDTO> {
      return request<GroupDTO>("GET", `/groups/${encodeURIComponent(id)}`, { auth: true, schema: groupDtoSchema });
    },
    patchGroup(id: string, body: PatchGroupReq): Promise<GroupDTO> {
      return request<GroupDTO>("PATCH", `/groups/${encodeURIComponent(id)}`, { body, auth: true, schema: groupDtoSchema });
    },
    deleteGroup(id: string): Promise<ArchivedRes> {
      return request<ArchivedRes>("DELETE", `/groups/${encodeURIComponent(id)}`, { auth: true });
    },

    // ── Invites ─────────────────────────────────────────────────────────────
    createInvite(groupId: string): Promise<InviteDTO> {
      return request<InviteDTO>("POST", `/groups/${encodeURIComponent(groupId)}/invites`, {
        body: {},
        auth: true,
        schema: inviteDtoSchema,
      });
    },
    revokeInvite(groupId: string, inviteId: string): Promise<RevokedRes> {
      return request<RevokedRes>(
        "DELETE",
        `/groups/${encodeURIComponent(groupId)}/invites/${encodeURIComponent(inviteId)}`,
        { auth: true },
      );
    },
    getInvitePreview(code: string): Promise<InvitePreviewDTO> {
      return request<InvitePreviewDTO>("GET", `/invites/${encodeURIComponent(code)}`, {
        auth: true,
        schema: invitePreviewDtoSchema,
      });
    },
    joinInvite(code: string): Promise<JoinResultDTO> {
      return request<JoinResultDTO>("POST", `/invites/${encodeURIComponent(code)}/join`, {
        auth: true,
        schema: joinResultDtoSchema,
      });
    },

    // ── Members ─────────────────────────────────────────────────────────────
    listMembers(groupId: string): Promise<MemberDTO[]> {
      return request<MemberDTO[]>("GET", `/groups/${encodeURIComponent(groupId)}/members`, {
        auth: true,
        schema: memberArraySchema,
      });
    },
    removeMember(groupId: string, userId: string): Promise<RemovedRes> {
      return request<RemovedRes>(
        "DELETE",
        `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
        { auth: true },
      );
    },
    leaveGroup(groupId: string): Promise<LeftRes> {
      return request<LeftRes>("POST", `/groups/${encodeURIComponent(groupId)}/leave`, { auth: true });
    },

    // ── Media ───────────────────────────────────────────────────────────────
    // Three-step upload flow: mediaInit (presign) → app PUTs raw bytes to
    // uploadUrl (NOT this client; the mobile transfer layer) → mediaComplete.
    mediaInit(body: MediaInitReq): Promise<MediaInitRes> {
      return request<MediaInitRes>("POST", "/media", { body, auth: true, schema: mediaInitResSchema });
    },
    mediaComplete(id: string): Promise<MediaItemDTO> {
      return request<MediaItemDTO>("POST", `/media/${encodeURIComponent(id)}/complete`, {
        auth: true,
        schema: mediaItemDtoSchema,
      });
    },
    getMediaToday(): Promise<MediaTodayRes> {
      return request<MediaTodayRes>("GET", "/media/today", { auth: true, schema: mediaTodayResSchema });
    },
    getMediaDownloadUrl(id: string): Promise<DownloadUrlRes> {
      return request<DownloadUrlRes>("GET", `/media/${encodeURIComponent(id)}/download-url`, {
        auth: true,
        schema: downloadUrlResSchema,
      });
    },
    deleteMedia(id: string): Promise<DeletedRes> {
      return request<DeletedRes>("DELETE", `/media/${encodeURIComponent(id)}`, { auth: true });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
