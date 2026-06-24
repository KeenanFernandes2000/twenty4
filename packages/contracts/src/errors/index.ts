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
