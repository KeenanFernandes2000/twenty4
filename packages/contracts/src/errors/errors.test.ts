import { expect, test } from "bun:test";
import {
  AppError,
  ERROR_STATUS,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  errorEnvelopeSchema,
  toErrorEnvelope,
} from "./index.ts";

test("AppError carries code/status/message and serializes to envelope", () => {
  const e = new AppError("FORBIDDEN", "nope");
  expect(e.code).toBe("FORBIDDEN");
  expect(e.status).toBe(403);
  expect(e.message).toBe("nope");
  expect(e.toEnvelope()).toEqual({ error: { code: "FORBIDDEN", status: 403, message: "nope" } });
  expect(e instanceof Error).toBe(true);
  expect(e instanceof AppError).toBe(true);
});

test("concrete errors map to their statuses", () => {
  expect(new UnauthorizedError().status).toBe(401);
  expect(new NotFoundError().status).toBe(404);
  expect(new ValidationError().status).toBe(422);
  expect(new NotFoundError() instanceof AppError).toBe(true);
});

test("ERROR_STATUS is the canonical map", () => {
  expect(ERROR_STATUS).toEqual({
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
    MEDIA_NOT_FOUND: 404,
    MEDIA_TOO_LARGE: 413,
    MEDIA_TYPE_NOT_ALLOWED: 415,
    DAILY_LIMIT_REACHED: 429,
    MEDIA_VALIDATION_FAILED: 422,
    RENDER_FAILED_RETRYABLE: 500,
    MONTAGE_ALREADY_GENERATING: 409,
    NOT_ENOUGH_MEDIA: 422,
    MONTAGE_NOT_OWNED: 403,
    GROUP_NOT_MEMBER: 403,
    RECAP_ALREADY_TODAY: 409,
    MONTAGE_NOT_FOUND: 404,
  });
});

test("errorEnvelopeSchema validates the wire shape", () => {
  const ok = errorEnvelopeSchema.safeParse(toErrorEnvelope("NOT_FOUND", "x"));
  expect(ok.success).toBe(true);
  const bad = errorEnvelopeSchema.safeParse({ error: { code: "NOPE", status: 404, message: "x" } });
  expect(bad.success).toBe(false);
});
