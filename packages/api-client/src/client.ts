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

// Slice 4 (groups + invites/join) DTOs.
import type {
  CreateGroupRequest,
  UpdateGroupRequest,
  CreateInviteRequest,
  GroupResponse,
  GroupListResponse,
  GroupMemberResponse,
  InviteResponse,
  InvitePreviewResponse,
  JoinGroupResponse,
} from "@twenty4/contracts/dto";

// Slice 2 (media: capture/upload + 4am day-window + validation) DTOs.
import type {
  MediaInitRequest,
  MediaInitResponse,
  MediaItemResponse,
  MediaDownloadUrlResponse,
  TodayMediaResponse,
} from "@twenty4/contracts/dto";

// Slice 5 (montage: generate → review → publish, replace/republish) DTOs.
import type {
  GenerateMontageRequest,
  RegenerateMontageRequest,
  PublishMontageRequest,
  ReplaceMontageRequest,
  MontageResponse,
  MontageGeneratingResponse,
  MontageOptionsResponse,
  DownloadUrlResponse,
} from "@twenty4/contracts/dto";

// Slice 6 (feed + social: reactions + comments) DTOs.
import type {
  FeedQuery,
  FeedResponse,
  UpsertReactionRequest,
  UpsertReactionResponse,
  DeleteReactionResponse,
  CreateCommentRequest,
  CommentResponse,
  CommentsResponse,
} from "@twenty4/contracts/dto";

/** Wire shape of GET /groups/:id/members (array of member rows). */
export interface GroupMembersResponse {
  items: GroupMemberResponse[];
}

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

    // --- groups (Slice 4) -----------------------------------------------------
    groups: {
      /** The caller's active groups (member count + role per group). */
      list: () => request<GroupListResponse>("/groups"),
      /** A single group the caller is a member of (403 if not). */
      get: (id: string) => request<GroupResponse>(`/groups/${id}`),
      /** Create a group; the caller becomes its owner. */
      create: (input: CreateGroupRequest) =>
        request<GroupResponse>("/groups", { method: "POST", body: input }),
      /** Owner/admin: update name / photo / status (archive). */
      update: (id: string, input: UpdateGroupRequest) =>
        request<GroupResponse>(`/groups/${id}`, { method: "PATCH", body: input }),
      /** Owner-only: archive the group (204). */
      archive: (id: string) => request<void>(`/groups/${id}`, { method: "DELETE" }),
      /** Caller leaves the group (204; sole-owner of a non-empty group → 409). */
      leave: (id: string) => request<void>(`/groups/${id}/leave`, { method: "POST" }),
      /** Members-only: list active members (+ role). */
      members: (id: string) => request<GroupMembersResponse>(`/groups/${id}/members`),
      /** Owner/admin removes a member (role hierarchy enforced; 204). */
      removeMember: (id: string, userId: string) =>
        request<void>(`/groups/${id}/members/${userId}`, { method: "DELETE" }),
      /** Owner/admin: mint an invite code (expiry + use-cap). */
      createInvite: (id: string, input?: CreateInviteRequest) =>
        request<InviteResponse>(`/groups/${id}/invites`, {
          method: "POST",
          body: input ?? {},
        }),
      /** Owner/admin: revoke an invite (204). */
      revokeInvite: (id: string, inviteId: string) =>
        request<void>(`/groups/${id}/invites/${inviteId}`, { method: "DELETE" }),
      // Deep link twenty4://invite/[code] → resolve + join (expiry + use-cap).
      /** Public-ish invite preview (name/photo/count + validity). */
      resolveInvite: (code: string) =>
        request<InvitePreviewResponse>(`/invites/${code}`),
      /** Redeem a code → join the group (atomic + race-safe). */
      joinInvite: (code: string) =>
        request<JoinGroupResponse>(`/invites/${code}/join`, { method: "POST" }),
    },

    // --- media (Slice 2) ------------------------------------------------------
    // Capture/upload + the 4am day-window + the validation hierarchy hand-off.
    media: {
      /**
       * Upload INIT: the server resolves `day_bucket` authoritatively from the
       * device tz, inserts a `pending` row, and returns a presigned PUT URL + the
       * new item id. The client then PUTs the bytes to `uploadUrl`, and calls
       * `complete(id)`.
       */
      init: (input: MediaInitRequest) =>
        request<MediaInitResponse>("/media", { method: "POST", body: input }),
      /** Mark the item uploaded → enqueues the validate-media job (§6). */
      complete: (id: string) =>
        request<MediaItemResponse>(`/media/${id}/complete`, { method: "POST" }),
      /** Today's collected items for the caller (Today screen). Pass the IANA tz. */
      today: (tz?: string) =>
        request<TodayMediaResponse>("/media/today", { query: { tz } }),
      /** Owner-only signed GET for the raw item (save-to-gallery, §11.10). */
      downloadUrl: (id: string) =>
        request<MediaDownloadUrlResponse>(`/media/${id}/download-url`),
      /** Owner removes an item → hard-delete (row + S3). */
      remove: (id: string) => request<void>(`/media/${id}`, { method: "DELETE" }),
    },

    // --- montage --------------------------------------------------------------
    montage: {
      // POST /montages → enqueue render; returns { montageId, status:'generating' }.
      // Poll `get(id)` (§7.3) until status === 'draft_ready' to drive 2.4 → 2.5.
      create: (input: GenerateMontageRequest) =>
        request<MontageGeneratingResponse>("/montages", { method: "POST", body: input }),
      // Owner-only status poll + montage view (presigned video/thumbnail when ready).
      get: (id: string) => request<MontageResponse>(`/montages/${id}`),
      // Available themes + music tracks for the 2.6 / 2.7 pickers.
      options: () => request<MontageOptionsResponse>("/montages/options"),
      // Theme/music tweak + regenerate (2.6 / 2.7); only while draft_ready/failed.
      regenerate: (id: string, input: RegenerateMontageRequest) =>
        request<MontageGeneratingResponse>(`/montages/${id}/regenerate`, {
          method: "POST",
          body: input,
        }),
      // Idempotent multi-group publish (2.8). Pass idempotencyKey for explicit dedupe;
      // a re-publish to the SAME groups is a natural no-op even without one.
      publish: (id: string, input: PublishMontageRequest, idempotencyKey?: string) =>
        request<MontageResponse>(`/montages/${id}/publish`, {
          method: "POST",
          body: input,
          idempotencyKey,
        }),
      // Replace prior montage (§5 Q2): publish the replacement + supersede the prior.
      replace: (id: string, input: ReplaceMontageRequest, idempotencyKey?: string) =>
        request<MontageResponse>(`/montages/${id}/replace`, {
          method: "POST",
          body: input,
          idempotencyKey,
        }),
      // Owner-only signed download URL (§11.10 / Q7) — serves the published montage
      // for save-to-gallery.
      downloadUrl: (id: string) => request<DownloadUrlResponse>(`/montages/${id}/download-url`),
      // Owner-only hard-delete (pre-expiry): cascades reactions + comments + S3 (204).
      remove: (id: string) => request<void>(`/montages/${id}`, { method: "DELETE" }),
    },

    // --- feed (Slice 6) -------------------------------------------------------
    // Cursor-paginated (10/page §10), member-group-scoped, block-filtered feed of
    // TODAY's published, non-expired montages. Pass `nextCursor` from the prior page
    // to page; optionally narrow to a single member group via `group`.
    feed: {
      list: (params: FeedQuery = {}) =>
        request<FeedResponse>("/feed", {
          query: { group: params.group, cursor: params.cursor, limit: params.limit ?? 10 },
        }),
    },

    // --- social (Slice 6: reactions + comments) ------------------------------
    // All gated server-side by montage viewability (shared active group + no block
    // either direction); a montage the caller can't view → 404.
    social: {
      /** Upsert the caller's ONE reaction (changing type replaces). Returns the summary. */
      react: (montageId: string, input: UpsertReactionRequest) =>
        request<UpsertReactionResponse>(`/montages/${montageId}/reactions`, {
          method: "POST",
          body: input,
        }),
      /** Remove the caller's reaction (idempotent). Returns the updated summary. */
      unreact: (montageId: string) =>
        request<DeleteReactionResponse>(`/montages/${montageId}/reactions`, {
          method: "DELETE",
        }),
      /** Cursor-paginated comments (oldest-first). */
      listComments: (montageId: string, cursor?: string) =>
        request<CommentsResponse>(`/montages/${montageId}/comments`, {
          query: { cursor },
        }),
      /** Add a comment (length-bounded, rate-limited). */
      addComment: (montageId: string, input: CreateCommentRequest) =>
        request<CommentResponse>(`/montages/${montageId}/comments`, {
          method: "POST",
          body: input,
        }),
      /** Delete a comment (own comment OR the montage owner can remove any). 204. */
      deleteComment: (commentId: string) =>
        request<void>(`/comments/${commentId}`, { method: "DELETE" }),
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
  // The API serializes typed errors into a `{ error: { code, message, status,
  // details } }` envelope (contracts `ApiError.toEnvelope`). Unwrap it; fall back
  // to a bare `{ code, message }` body, then to HTTP-status defaults.
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : body;
  const code =
    isRecord(envelope) && typeof envelope.code === "string"
      ? envelope.code
      : httpFallbackCode(status);
  const message =
    isRecord(envelope) && typeof envelope.message === "string"
      ? envelope.message
      : `Request failed with status ${status}`;
  const details =
    isRecord(envelope) && isRecord(envelope.details) ? envelope.details : undefined;
  const shape: ApiErrorShape = { code, message, status };

  // Preserve the unwrapped envelope (incl. `details`) as the error body so
  // callers can switch on `details.reason` (e.g. `already_member`, `sole_owner`).
  const errorBody = details !== undefined ? { ...(envelope as object), details } : envelope;

  if (status === 401) return new UnauthorizedError(shape, errorBody);
  if (status === 403 && code === "suspended") return new SuspendedError(shape, errorBody);
  return new ApiError(shape, errorBody);
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
