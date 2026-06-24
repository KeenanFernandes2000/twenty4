// The raw-BA-OTP deny-list lives in ONE place; assert its concrete contents so a
// future BA upgrade that adds/renames an OTP route is caught here.
import { expect, test } from "bun:test";
import { BA_OTP_DENY_PATHS, buildDenyPathSet, normalizeDenyPath } from "../src/auth/denyList.ts";

test("deny-list enumerates the concrete BA OTP path set", () => {
  // The known BA 1.6 phone-number + email-otp HTTP routes.
  expect(BA_OTP_DENY_PATHS).toContain("/phone-number/send-otp");
  expect(BA_OTP_DENY_PATHS).toContain("/phone-number/verify");
  expect(BA_OTP_DENY_PATHS).toContain("/email-otp/send-verification-otp");
  expect(BA_OTP_DENY_PATHS).toContain("/email-otp/verify-email");
  expect(BA_OTP_DENY_PATHS).toContain("/sign-in/email-otp");
  expect(BA_OTP_DENY_PATHS).toContain("/sign-in/phone-number");
  // At least the v1-style breadth (≥ a dozen distinct OTP paths).
  expect(BA_OTP_DENY_PATHS.length).toBeGreaterThanOrEqual(12);
});

test("buildDenyPathSet expands across mount prefixes (bare + /api/auth)", () => {
  const set = buildDenyPathSet();
  expect(set.has("/phone-number/send-otp")).toBe(true);
  expect(set.has("/api/auth/phone-number/send-otp")).toBe(true);
  expect(set.has("/email-otp/send-verification-otp")).toBe(true);
});

test("deny-set + normalizeDenyPath match case- and trailing-slash-insensitively", () => {
  const set = buildDenyPathSet();
  // The set stores normalized (lowercase, no trailing slash) entries.
  expect(set.has(normalizeDenyPath("/PHONE-NUMBER/SEND-OTP"))).toBe(true);
  expect(set.has(normalizeDenyPath("/phone-number/send-otp/"))).toBe(true);
  expect(set.has(normalizeDenyPath("/Email-OTP/Send-Verification-OTP/"))).toBe(true);
  // Sanity: a non-deny path does NOT match.
  expect(set.has(normalizeDenyPath("/auth/start"))).toBe(false);
});
