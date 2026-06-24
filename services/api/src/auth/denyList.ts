// Raw Better Auth OTP HTTP path deny-list — kept in ONE place and asserted in a
// test. All OTP traffic MUST flow through the /auth façade (which drives BA via
// in-process auth.api.*); a direct POST to any raw BA OTP path is 403'd so it
// can't bypass the throttle. (We never mount BA's HTTP catch-all; this hook makes
// the denial explicit + testable regardless of any future mount.)
//
// Enumerated from the live BA endpoint set (phone-number + email-otp plugins).
export const BA_OTP_DENY_PATHS = [
  // phone-number plugin
  "/phone-number/send-otp",
  "/phone-number/verify",
  "/phone-number/sign-in",
  "/sign-in/phone-number",
  "/phone-number/request-password-reset",
  "/phone-number/reset-password",
  // email-otp plugin
  "/email-otp/send-verification-otp",
  "/email-otp/verify-email",
  "/email-otp/check-verification-otp",
  "/email-otp/request-password-reset",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
  "/sign-in/email-otp",
  "/forget-password/email-otp",
  // generic verification endpoints that could leak OTP state
  "/verify-email",
] as const;

// Prefixes under which a raw BA mount would expose these (bare + common mounts).
// We match a request path that ENDS WITH any deny path under these prefixes.
export const BA_MOUNT_PREFIXES = ["", "/api/auth", "/auth/ba", "/better-auth"] as const;

// Normalize a path for deny-list comparison: lowercase + strip trailing slashes.
// So `/PHONE-NUMBER/SEND-OTP` and `/phone-number/send-otp/` both match the
// canonical entry. (The deny-list itself is enumerated in lowercase below.)
export function normalizeDenyPath(path: string): string {
  return (path.replace(/\/+$/, "") || "/").toLowerCase();
}

// Build the concrete set of full paths to deny (cartesian of prefixes × paths),
// stored NORMALIZED. The real guarantee is that BA's HTTP catch-all handler is
// never mounted; this 403 hook is defense-in-depth so a future accidental mount
// still can't bypass the throttled /auth façade.
export function buildDenyPathSet(): Set<string> {
  const set = new Set<string>();
  for (const prefix of BA_MOUNT_PREFIXES) {
    for (const p of BA_OTP_DENY_PATHS) {
      set.add(normalizeDenyPath(`${prefix}${p}`));
    }
  }
  return set;
}
