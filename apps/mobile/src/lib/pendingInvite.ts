// pendingInvite — a tiny module-level stash for a deep-linked invite code that
// arrived while the user was logged OUT. The deep-link route (src/app/invites/[code])
// records the code here before bouncing to the auth flow; after the user signs in
// the Groups home (`(app)/index`) consumes it once and navigates to the invite so
// the link "resumes". Module-level (not persisted) — only survives this app run,
// which is exactly the right lifetime for a single cold/warm deep-link handoff.
let pendingInviteCode: string | null = null;

/** Stash a code to resume after login. Overwrites any previous pending code. */
export function setPendingInvite(code: string): void {
  pendingInviteCode = code;
}

/** Read WITHOUT consuming (peek). */
export function peekPendingInvite(): string | null {
  return pendingInviteCode;
}

/** Read AND clear in one shot — the resume site uses this so it only fires once. */
export function consumePendingInvite(): string | null {
  const code = pendingInviteCode;
  pendingInviteCode = null;
  return code;
}

/** Drop any pending code (e.g. on full sign-out). */
export function clearPendingInvite(): void {
  pendingInviteCode = null;
}
