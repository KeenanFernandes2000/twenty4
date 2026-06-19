// @twenty4/api-client — typed fetch client scaffold.
//
// One method per §8 endpoint, grouped by resource. Method bodies are filled in
// per slice (see TODO(slice N) markers). Where a contracts DTO name is not yet
// settled, the signature uses `unknown` + a TODO; the real type is wired later
// from `@twenty4/contracts/dto`.
//
// Kept deliberately dependency-light: uses the platform `fetch` (Node 22 /
// React Native / browser all provide it).

// Contracts is the single source of truth. Subpaths exist but their exported
// names are owned by the contracts agent; we import lazily / as `unknown` until
// each slice pins the concrete DTO. Type-only import keeps this compiling even
// before contracts is fully populated.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type * as Contracts from "@twenty4/contracts";

// Slice 3 (auth + users) DTOs — now pinned to the real contracts types.
import type {
  AuthStartRequest,
  AuthStartResponse,
  AuthVerifyRequest,
  AuthRefreshRequest,
  SessionTokens,
  UpdateUserRequest,
  MeResponse,
} from "@twenty4/contracts/dto";

// -----------------------------------------------------------------------------
// Errors (typed; shape: { code, message, status })
// -----------------------------------------------------------------------------

export interface ApiErrorShape {
  code: string;
  message: string;
  status: number;
}

/** Base error thrown for any non-2xx response. */
export class ApiError extends Error implements ApiErrorShape {
  readonly code: string;
  readonly status: number;
  /** Raw parsed response body, when available. */
  readonly body: unknown;

  constructor(shape: ApiErrorShape, body?: unknown) {
    super(shape.message);
    this.name = "ApiError";
    this.code = shape.code;
    this.status = shape.status;
    this.body = body;
  }
}

/** 401 — no/invalid session. Client should clear auth + route to sign-in. */
export class UnauthorizedError extends ApiError {
  constructor(shape: ApiErrorShape, body?: unknown) {
    super(shape, body);
    this.name = "UnauthorizedError";
  }
}

/** 403 with code `suspended` — account suspended/banned; route to 7.5 gate. */
export class SuspendedError extends ApiError {
  constructor(shape: ApiErrorShape, body?: unknown) {
    super(shape, body);
    this.name = "SuspendedError";
  }
}

// -----------------------------------------------------------------------------
// Client config
// -----------------------------------------------------------------------------

export interface ApiClientOptions {
  /** Base URL of the API, e.g. http://127.0.0.1:3000 (no trailing slash). */
  baseUrl: string;
  /**
   * Returns the current bearer token (or null/undefined when signed out).
   * Async so callers can read from expo-secure-store. Injected as
   * `Authorization: Bearer <token>` on every request.
   */
  getToken: () => string | null | undefined | Promise<string | null | undefined>;
  /** Optional fetch override (tests / RN polyfills). Defaults to global fetch. */
  fetch?: typeof fetch;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON-serializable body. */
  body?: unknown;
  /** Query params; undefined/null values are skipped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Per-request idempotency key (publish/replace — §8). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;

  function buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /**
   * Core request helper: injects auth, sets JSON headers, parses JSON, and
   * throws a typed error on non-2xx. Generic over the expected response type.
   */
  async function request<TResponse = unknown>(
    path: string,
    opts: RequestOptions = {},
  ): Promise<TResponse> {
    const token = await options.getToken();

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const res = await doFetch(buildUrl(path, opts.query), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });

    // Parse body once (may be empty, e.g. 204).
    const raw = await res.text();
    let parsed: unknown = undefined;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!res.ok) {
      throw toApiError(res.status, parsed);
    }

    return parsed as TResponse;
  }

  // ---------------------------------------------------------------------------
  // Resource groups (PLAN §8). Method bodies are slice-filled TODOs.
  // DTO types referenced as `unknown` until each slice pins the contracts name.
  // ---------------------------------------------------------------------------

  return {
    /** Low-level escape hatch; prefer the typed resource methods. */
    request,

    // --- auth -----------------------------------------------------------------
    // twenty4 façade over Better Auth: /auth/start|verify|refresh|logout (§3).
    auth: {
      /** Begin email/phone OTP (or social entry). Returns a challengeId for verify. */
      start: (input: AuthStartRequest) =>
        request<AuthStartResponse>("/auth/start", { method: "POST", body: input }),
      /** Submit the OTP → session tokens (accessToken is the bearer token). */
      verify: (input: AuthVerifyRequest) =>
        request<SessionTokens>("/auth/verify", { method: "POST", body: input }),
      /** Re-validate the current session, returning fresh tokens. */
      refresh: (input?: AuthRefreshRequest) =>
        request<SessionTokens>("/auth/refresh", { method: "POST", body: input }),
      /** Revoke the current session (204). */
      logout: () => request<void>("/auth/logout", { method: "POST" }),
    },

    // --- users ----------------------------------------------------------------
    users: {
      /** The self profile (requires a session). */
      me: () => request<MeResponse>("/users/me"),
      /** Profile setup / edit (display_name, username, profile_photo_url). */
      updateMe: (input: UpdateUserRequest) =>
        request<MeResponse>("/users/me", { method: "PATCH", body: input }),
      // DELETE /users/me — revokes sessions then enqueues purge (5.6 / §5).
      deleteMe: () => request<void>("/users/me", { method: "DELETE" }),
    },

    // --- groups ---------------------------------------------------------------
    groups: {
      // TODO(slice 4): group + member + invite DTOs.
      list: () => request<unknown>("/groups"),
      get: (id: string) => request<unknown>(`/groups/${id}`),
      create: (input: unknown) => request<unknown>("/groups", { method: "POST", body: input }),
      update: (id: string, input: unknown) =>
        request<unknown>(`/groups/${id}`, { method: "PATCH", body: input }),
      leave: (id: string) => request<void>(`/groups/${id}/leave`, { method: "POST" }),
      members: (id: string) => request<unknown>(`/groups/${id}/members`),
      createInvite: (id: string, input: unknown) =>
        request<unknown>(`/groups/${id}/invites`, { method: "POST", body: input }),
      // Deep link twenty4://invite/[code] → resolve + join (expiry + use-cap).
      resolveInvite: (code: string) => request<unknown>(`/invites/${code}`),
      joinInvite: (code: string) => request<unknown>(`/invites/${code}/join`, { method: "POST" }),
    },

    // --- media ----------------------------------------------------------------
    media: {
      // TODO(slice 2): presign + media-item DTOs.
      // Request a signed PUT for raw upload (returns url + key).
      createUpload: (input: unknown) =>
        request<unknown>("/media/uploads", { method: "POST", body: input }),
      // Register an uploaded item against today's day_bucket (§5/§6 validation).
      create: (input: unknown) => request<unknown>("/media", { method: "POST", body: input }),
      // Today's collected items for the current user.
      today: () => request<unknown>("/media/today"),
      remove: (id: string) => request<void>(`/media/${id}`, { method: "DELETE" }),
    },

    // --- montage --------------------------------------------------------------
    montage: {
      // TODO(slice 5): montage create/poll/publish DTOs.
      // POST /montages → enqueue render; poll status (§7.3) drives 2.4.
      create: (input: unknown) => request<unknown>("/montages", { method: "POST", body: input }),
      get: (id: string) => request<unknown>(`/montages/${id}`),
      // Theme/music tweak + regenerate (2.6 / 2.7).
      regenerate: (id: string, input: unknown) =>
        request<unknown>(`/montages/${id}/regenerate`, { method: "POST", body: input }),
      // Idempotent multi-group publish (2.8). Pass idempotencyKey.
      publish: (id: string, input: unknown, idempotencyKey?: string) =>
        request<unknown>(`/montages/${id}/publish`, {
          method: "POST",
          body: input,
          idempotencyKey,
        }),
      // Replace prior montage (§5 Q2). Idempotency-guarded.
      replace: (id: string, input: unknown, idempotencyKey?: string) =>
        request<unknown>(`/montages/${id}/replace`, {
          method: "POST",
          body: input,
          idempotencyKey,
        }),
      // Owner-only signed download URL (§11.10 / Q7).
      downloadUrl: (id: string) => request<unknown>(`/montages/${id}/download-url`),
    },

    // --- feed -----------------------------------------------------------------
    feed: {
      // TODO(slice 6): cursor-paginated feed DTO (10/page §10, block-filtered).
      list: (cursor?: string) =>
        request<unknown>("/feed", { query: { cursor, limit: 10 } }),
    },

    // --- social (reactions + comments) ---------------------------------------
    social: {
      // TODO(slice 6): reaction + comment DTOs.
      react: (montageId: string, input: unknown) =>
        request<unknown>(`/montages/${montageId}/reactions`, { method: "POST", body: input }),
      unreact: (montageId: string) =>
        request<void>(`/montages/${montageId}/reactions`, { method: "DELETE" }),
      listComments: (montageId: string, cursor?: string) =>
        request<unknown>(`/montages/${montageId}/comments`, { query: { cursor } }),
      addComment: (montageId: string, input: unknown) =>
        request<unknown>(`/montages/${montageId}/comments`, { method: "POST", body: input }),
      deleteComment: (montageId: string, commentId: string) =>
        request<void>(`/montages/${montageId}/comments/${commentId}`, { method: "DELETE" }),
    },

    // --- safety (report + block) ---------------------------------------------
    safety: {
      // TODO(slice 8): report + block DTOs (6.1 / 6.2).
      report: (input: unknown) => request<unknown>("/reports", { method: "POST", body: input }),
      block: (userId: string) =>
        request<void>(`/blocks/${userId}`, { method: "POST" }),
      unblock: (userId: string) => request<void>(`/blocks/${userId}`, { method: "DELETE" }),
      listBlocked: () => request<unknown>("/blocks"),
    },

    // --- admin (minimal moderation/ops; apps/admin) --------------------------
    admin: {
      // TODO(slice 8): admin search/suspend/ban/report/jobs DTOs.
      searchUsers: (q: string) => request<unknown>("/admin/users", { query: { q } }),
      suspendUser: (userId: string, input: unknown) =>
        request<unknown>(`/admin/users/${userId}/suspend`, { method: "POST", body: input }),
      banUser: (userId: string, input: unknown) =>
        request<unknown>(`/admin/users/${userId}/ban`, { method: "POST", body: input }),
      listReports: (cursor?: string) =>
        request<unknown>("/admin/reports", { query: { cursor } }),
      removeContent: (montageId: string, input: unknown) =>
        request<unknown>(`/admin/montages/${montageId}/remove`, { method: "POST", body: input }),
      listFailedJobs: () => request<unknown>("/admin/jobs/failed"),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

// -----------------------------------------------------------------------------
// Internal: map an HTTP error response to a typed ApiError.
// -----------------------------------------------------------------------------

function toApiError(status: number, body: unknown): ApiError {
  // Expected error envelope: { code, message }. Fall back gracefully.
  const code =
    isRecord(body) && typeof body.code === "string" ? body.code : httpFallbackCode(status);
  const message =
    isRecord(body) && typeof body.message === "string"
      ? body.message
      : `Request failed with status ${status}`;
  const shape: ApiErrorShape = { code, message, status };

  if (status === 401) return new UnauthorizedError(shape, body);
  if (status === 403 && code === "suspended") return new SuspendedError(shape, body);
  return new ApiError(shape, body);
}

function httpFallbackCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
