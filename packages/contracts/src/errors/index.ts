// @twenty4/contracts — error taxonomy + envelope.
// The single source of truth for API error codes/statuses and the wire shape
// every error response uses: { error: { code, status, message } }.
// The API's global error handler maps thrown errors onto this taxonomy.
import { z } from "zod";

// The canonical error codes. Each maps to exactly one HTTP status.
export const ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "INTERNAL",
  // Account-status gate (M2): session-create denial codes. All 403.
  "ACCOUNT_SUSPENDED",
  "ACCOUNT_BANNED",
  "ACCOUNT_DELETED",
  // Conflict (M2): e.g. username already taken on POST /users.
  "CONFLICT",
  // ── Groups (M3) ────────────────────────────────────────────────────────────
  "NOT_A_MEMBER", // 403 — caller has no active membership in the group
  "NOT_OWNER", // 403 — caller is not the group's owner
  "INVITE_NOT_FOUND", // 404 — no invite for the given code
  "INVITE_EXPIRED", // 410 — past expires_at
  "INVITE_USED_UP", // 403 — use_count >= max_uses
  "INVITE_REVOKED", // 403 — revoked_at is set
  "ALREADY_MEMBER", // 409 — caller is already an active member
  "GROUP_NOT_FOUND", // 404 — no group for the given id
  "CANNOT_REMOVE_SELF", // 400 — owner tried to remove themselves
  "CANNOT_REMOVE_OWNER", // 400 — tried to remove the owner row
  "OWNER_CANNOT_LEAVE", // 400 — owner must DELETE the group, not leave
  // ── Media (M4) ─────────────────────────────────────────────────────────────
  "MEDIA_NOT_FOUND", // 404 — no media item for the id (or not the caller's)
  "MEDIA_TOO_LARGE", // 413 — actual object size exceeds the per-item cap
  "MEDIA_TYPE_NOT_ALLOWED", // 415 — content-type not in the MIME allowlist
  "DAILY_LIMIT_REACHED", // 429 — caller already at the per-day item cap
  "MEDIA_VALIDATION_FAILED", // 422 — /complete HeadObject gate rejected the upload
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// Code → HTTP status. Keep in lockstep with the concrete error classes below.
export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  ACCOUNT_SUSPENDED: 403,
  ACCOUNT_BANNED: 403,
  ACCOUNT_DELETED: 403,
  CONFLICT: 409,
  // ── Groups (M3) ────────────────────────────────────────────────────────────
  NOT_A_MEMBER: 403,
  NOT_OWNER: 403,
  INVITE_NOT_FOUND: 404,
  INVITE_EXPIRED: 410,
  INVITE_USED_UP: 403,
  INVITE_REVOKED: 403,
  ALREADY_MEMBER: 409,
  GROUP_NOT_FOUND: 404,
  CANNOT_REMOVE_SELF: 400,
  CANNOT_REMOVE_OWNER: 400,
  OWNER_CANNOT_LEAVE: 400,
  // ── Media (M4) ─────────────────────────────────────────────────────────────
  MEDIA_NOT_FOUND: 404,
  MEDIA_TOO_LARGE: 413,
  MEDIA_TYPE_NOT_ALLOWED: 415,
  DAILY_LIMIT_REACHED: 429,
  MEDIA_VALIDATION_FAILED: 422,
};

// Base application error. Carries the taxonomy { code, status, message } so the
// global handler can serialize it straight into the envelope with no mapping.
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status = ERROR_STATUS[code]) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    // Restore prototype chain (TS target ES2022 + extends Error).
    Object.setPrototypeOf(this, new.target.prototype);
  }

  // Serialize to the wire envelope shape.
  toEnvelope(): ErrorEnvelope {
    return { error: { code: this.code, status: this.status, message: this.message } };
  }
}

// Concrete errors — one per code. Default messages are safe to leak (no internals).
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super("UNAUTHORIZED", message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super("FORBIDDEN", message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed") {
    super("VALIDATION_FAILED", message);
    this.name = "ValidationError";
  }
}

export class RateLimitedError extends AppError {
  constructor(message = "Rate limited") {
    super("RATE_LIMITED", message);
    this.name = "RateLimitedError";
  }
}

export class InternalError extends AppError {
  constructor(message = "Internal server error") {
    super("INTERNAL", message);
    this.name = "InternalError";
  }
}

// Account-status gate (M2) — one per blocked status. All 403.
export class AccountSuspendedError extends AppError {
  constructor(message = "Account suspended") {
    super("ACCOUNT_SUSPENDED", message);
    this.name = "AccountSuspendedError";
  }
}

export class AccountBannedError extends AppError {
  constructor(message = "Account banned") {
    super("ACCOUNT_BANNED", message);
    this.name = "AccountBannedError";
  }
}

export class AccountDeletedError extends AppError {
  constructor(message = "Account deleted") {
    super("ACCOUNT_DELETED", message);
    this.name = "AccountDeletedError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super("CONFLICT", message);
    this.name = "ConflictError";
  }
}

// ── Groups (M3) ──────────────────────────────────────────────────────────────
export class NotAMemberError extends AppError {
  constructor(message = "You are not a member of this group") {
    super("NOT_A_MEMBER", message);
    this.name = "NotAMemberError";
  }
}

export class NotOwnerError extends AppError {
  constructor(message = "Only the group owner may perform this action") {
    super("NOT_OWNER", message);
    this.name = "NotOwnerError";
  }
}

export class InviteNotFoundError extends AppError {
  constructor(message = "Invite not found") {
    super("INVITE_NOT_FOUND", message);
    this.name = "InviteNotFoundError";
  }
}

export class InviteExpiredError extends AppError {
  constructor(message = "Invite has expired") {
    super("INVITE_EXPIRED", message);
    this.name = "InviteExpiredError";
  }
}

export class InviteUsedUpError extends AppError {
  constructor(message = "Invite has reached its maximum uses") {
    super("INVITE_USED_UP", message);
    this.name = "InviteUsedUpError";
  }
}

export class InviteRevokedError extends AppError {
  constructor(message = "Invite has been revoked") {
    super("INVITE_REVOKED", message);
    this.name = "InviteRevokedError";
  }
}

export class AlreadyMemberError extends AppError {
  constructor(message = "You are already a member of this group") {
    super("ALREADY_MEMBER", message);
    this.name = "AlreadyMemberError";
  }
}

export class GroupNotFoundError extends AppError {
  constructor(message = "Group not found") {
    super("GROUP_NOT_FOUND", message);
    this.name = "GroupNotFoundError";
  }
}

export class CannotRemoveSelfError extends AppError {
  constructor(message = "Use leave to remove yourself; owners cannot self-remove") {
    super("CANNOT_REMOVE_SELF", message);
    this.name = "CannotRemoveSelfError";
  }
}

export class CannotRemoveOwnerError extends AppError {
  constructor(message = "The group owner cannot be removed") {
    super("CANNOT_REMOVE_OWNER", message);
    this.name = "CannotRemoveOwnerError";
  }
}

export class OwnerCannotLeaveError extends AppError {
  constructor(message = "The owner cannot leave; delete the group instead") {
    super("OWNER_CANNOT_LEAVE", message);
    this.name = "OwnerCannotLeaveError";
  }
}

// ── Media (M4) ──────────────────────────────────────────────────────────────
export class MediaNotFoundError extends AppError {
  constructor(message = "Media item not found") {
    super("MEDIA_NOT_FOUND", message);
    this.name = "MediaNotFoundError";
  }
}

export class MediaTooLargeError extends AppError {
  constructor(message = "Media exceeds the maximum allowed size") {
    super("MEDIA_TOO_LARGE", message);
    this.name = "MediaTooLargeError";
  }
}

export class MediaTypeNotAllowedError extends AppError {
  constructor(message = "Media content-type is not allowed") {
    super("MEDIA_TYPE_NOT_ALLOWED", message);
    this.name = "MediaTypeNotAllowedError";
  }
}

export class DailyLimitReachedError extends AppError {
  constructor(message = "Daily media limit reached") {
    super("DAILY_LIMIT_REACHED", message);
    this.name = "DailyLimitReachedError";
  }
}

export class MediaValidationFailedError extends AppError {
  constructor(message = "Media validation failed") {
    super("MEDIA_VALIDATION_FAILED", message);
    this.name = "MediaValidationFailedError";
  }
}

// Zod schema for the error envelope wire shape: { error: { code, status, message } }.
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    status: z.number().int(),
    message: z.string(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

// Helper to build an envelope from loose parts (used by the not-found handler etc.).
export function toErrorEnvelope(code: ErrorCode, message: string, status = ERROR_STATUS[code]): ErrorEnvelope {
  return { error: { code, status, message } };
}
