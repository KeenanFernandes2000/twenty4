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
  });
});

test("errorEnvelopeSchema validates the wire shape", () => {
  const ok = errorEnvelopeSchema.safeParse(toErrorEnvelope("NOT_FOUND", "x"));
  expect(ok.success).toBe(true);
  const bad = errorEnvelopeSchema.safeParse({ error: { code: "NOPE", status: 404, message: "x" } });
  expect(bad.success).toBe(false);
});
