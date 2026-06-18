/**
 * Auth & onboarding DTOs (§8 Auth & onboarding).
 *
 * Backed by Better Auth (email/phone OTP + Apple/Google). These DTOs describe
 * the twenty4 façade endpoints (`/auth/start|verify|refresh|logout`); Better
 * Auth owns the underlying session/token storage.
 */
import { z } from 'zod';
import { authProviderSchema } from '../enums.js';

/** POST /auth/start — begin phone/email/social auth. */
export const authStartRequestSchema = z
  .object({
    method: z.enum(['phone', 'email', 'apple', 'google']),
    /** Required for phone/email; absent for social (token-based). */
    identifier: z.string().min(1).optional(),
    /** OAuth id token for apple/google flows. */
    idToken: z.string().optional(),
  })
  .strict();
export type AuthStartRequest = z.infer<typeof authStartRequestSchema>;

export const authStartResponseSchema = z
  .object({
    /** Opaque challenge id to pair with the verify step (OTP flows). */
    challengeId: z.string().optional(),
    /** True once a session was issued directly (social flows). */
    authenticated: z.boolean().default(false),
  })
  .strict();
export type AuthStartResponse = z.infer<typeof authStartResponseSchema>;

/** POST /auth/verify — submit OTP. */
export const authVerifyRequestSchema = z
  .object({
    challengeId: z.string(),
    code: z.string().min(4).max(8),
  })
  .strict();
export type AuthVerifyRequest = z.infer<typeof authVerifyRequestSchema>;

/** Session tokens returned by verify/refresh. */
export const sessionTokensSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number().int(),
    /** True if no profile exists yet → client routes to profile-setup (1.4). */
    needsProfile: z.boolean().default(false),
    provider: authProviderSchema.optional(),
  })
  .strict();
export type SessionTokens = z.infer<typeof sessionTokensSchema>;

/** POST /auth/refresh. */
export const authRefreshRequestSchema = z
  .object({ refreshToken: z.string() })
  .strict();
export type AuthRefreshRequest = z.infer<typeof authRefreshRequestSchema>;

/** POST /auth/logout (body optional — session from header). */
export const authLogoutRequestSchema = z
  .object({ refreshToken: z.string().optional() })
  .strict();
export type AuthLogoutRequest = z.infer<typeof authLogoutRequestSchema>;
