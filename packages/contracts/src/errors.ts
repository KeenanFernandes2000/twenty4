/**
 * Typed errors — the consistent error taxonomy (§8 cross-cutting, §11).
 *
 * `ApiError` is the serialized shape returned by the API and parsed by the
 * client: `{ code, message, status, details? }`. `code` is a stable machine
 * string (clients switch on it); `message` is human-facing; `status` is the HTTP
 * status; `details` carries optional non-PII context (e.g. Zod field issues).
 *
 * Helper constructors keep status↔code mapping in one place.
 */
import { z } from 'zod';

/* ------------------------------- error codes ------------------------------- */

export const ERROR_CODES = [
  'unauthorized', // 401 — no/invalid session
  'suspended', // 403 — account suspended (→ Suspended gate 7.5)
  'banned', // 403 — account banned
  'forbidden', // 403 — authenticated but not allowed (e.g. not a group member)
  'not_found', // 404 — missing OR expired/deleted content (§6: expired → 404)
  'validation', // 422 — request body failed schema validation
  'conflict', // 409 — generic state conflict
  'idempotency_conflict', // 409 — idempotency key reused with a different body
  'rate_limited', // 429 — rate limit hit (upload/comment/reaction/invite-join)
  'invite_invalid', // 410 — invite revoked/expired/used-up (Q11)
  'payload_too_large', // 413 — item over size/duration limits (§10)
  'unsupported_media', // 415 — unsupported mime/codec (§10)
  'render_failed', // 422 — montage render failed (after retry, §7.4)
  'internal', // 500 — unexpected
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Default HTTP status for each code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  suspended: 403,
  banned: 403,
  forbidden: 403,
  not_found: 404,
  validation: 422,
  conflict: 409,
  idempotency_conflict: 409,
  rate_limited: 429,
  invite_invalid: 410,
  payload_too_large: 413,
  unsupported_media: 415,
  render_failed: 422,
  internal: 500,
};

/* -------------------------------- ApiError --------------------------------- */

export const apiErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string(),
    status: z.number().int(),
    /** Optional non-PII context (field issues, retry-after seconds, etc.). */
    details: z.record(z.unknown()).optional(),
  })
  .strict();

/** The wire shape of an error (serialized). */
export type ApiErrorShape = z.infer<typeof apiErrorSchema>;

/** Standard error envelope returned by every endpoint on failure. */
export const apiErrorEnvelopeSchema = z.object({ error: apiErrorSchema }).strict();
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;

/**
 * Throwable error carrying the wire shape. The API serializes `.toJSON()` into
 * the `{ error }` envelope; the client reconstructs from a parsed `ApiErrorShape`.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>,
    status?: number,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code];
    this.details = details;
  }

  toJSON(): ApiErrorShape {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  /** Wrap into the `{ error }` envelope sent on the wire. */
  toEnvelope(): ApiErrorEnvelope {
    return { error: this.toJSON() };
  }
}

/* ----------------------------- helper builders ----------------------------- */

const make =
  (code: ErrorCode) =>
  (message?: string, details?: Record<string, unknown>): ApiError =>
    new ApiError(code, message, details);

export const errors = {
  unauthorized: make('unauthorized'),
  suspended: make('suspended'),
  banned: make('banned'),
  forbidden: make('forbidden'),
  notFound: make('not_found'),
  validation: make('validation'),
  conflict: make('conflict'),
  idempotencyConflict: make('idempotency_conflict'),
  rateLimited: make('rate_limited'),
  inviteInvalid: make('invite_invalid'),
  payloadTooLarge: make('payload_too_large'),
  unsupportedMedia: make('unsupported_media'),
  renderFailed: make('render_failed'),
  internal: make('internal'),
} as const;

/** Type guard for a parsed wire error. */
export const isApiErrorShape = (v: unknown): v is ApiErrorShape =>
  apiErrorSchema.safeParse(v).success;
