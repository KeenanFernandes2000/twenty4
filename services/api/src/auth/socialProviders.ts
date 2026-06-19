/**
 * SocialProvider registry (Apple + Google) — STUBBED.
 *
 * Apple + Google are "configured-but-stub": present in the registry with no real
 * client IDs, so the OAuth routes exist and the app can show the buttons, but a
 * real sign-in can't complete until credentials are provisioned. Apple MUST be
 * present whenever any social login ships (App Store Review Guideline 4.8 / Sign
 * in with Apple requirement), so it stays in the registry even while stubbed.
 *
 * Behind this `SocialProvider` interface the real client IDs/secrets drop in via
 * env later (GOOGLE_CLIENT_ID, APPLE_CLIENT_ID, ...) with zero call-site changes.
 */
import type { AuthProvider } from '@twenty4/contracts/enums';

/** A social identity provider entry. */
export interface SocialProvider {
  /** Matches the `auth_provider` enum value. */
  id: Extract<AuthProvider, 'apple' | 'google'>;
  /** Human label for UI/registry. */
  label: string;
  /** OAuth client id (empty ⇒ stub: route exists, real sign-in not yet wired). */
  clientId: string;
  clientSecret: string;
  /** True until real credentials are provisioned. */
  stub: boolean;
}

/**
 * The configured providers. Credentials come from env when present; otherwise the
 * entry is a stub. Apple is always registered (store rule).
 */
export const socialProviders: SocialProvider[] = [
  {
    id: 'apple',
    label: 'Apple',
    clientId: process.env.APPLE_CLIENT_ID ?? '',
    clientSecret: process.env.APPLE_CLIENT_SECRET ?? '',
    stub: !process.env.APPLE_CLIENT_ID,
  },
  {
    id: 'google',
    label: 'Google',
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    stub: !process.env.GOOGLE_CLIENT_ID,
  },
];

/**
 * Shape Better Auth's `socialProviders` config from the registry. Stubs still get
 * registered (with placeholder ids) so the OAuth endpoints mount; real sign-in
 * 501s at the façade layer until `stub` flips false.
 */
export function betterAuthSocialConfig(): Record<
  string,
  { clientId: string; clientSecret: string }
> {
  const cfg: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const p of socialProviders) {
    cfg[p.id] = {
      // Better Auth requires non-empty strings; use a clearly-fake placeholder
      // for stubs so a misconfigured prod fails loudly rather than silently.
      clientId: p.clientId || `stub-${p.id}-client-id`,
      clientSecret: p.clientSecret || `stub-${p.id}-client-secret`,
    };
  }
  return cfg;
}

export const isSocialProviderStubbed = (id: string): boolean =>
  socialProviders.find((p) => p.id === id)?.stub ?? true;
