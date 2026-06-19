/**
 * Better Auth 1.6 instance — the single auth core for twenty4.
 *
 * - Backing store: our Drizzle + postgres.js `db`, schema from @twenty4/contracts.
 * - User model maps onto the EXISTING `users` table (ONE source of user truth):
 *     name → display_name, image → profile_photo_url, emailVerified → email_verified.
 *   `username`/`displayName` are added as additionalFields (input:false) only so
 *   the adapter knows the columns exist; the app fills them at profile-setup.
 * - Sessions live in Postgres (`session` table) ⇒ revocable on suspend/ban/delete.
 * - Plugins: emailOTP + phoneNumber (REAL OTP via pluggable dev transport) + bearer
 *   (so the mobile client and tests can use `Authorization: Bearer <token>`).
 * - Social: Apple + Google configured behind the SocialProvider registry (stubbed).
 *
 * IDs: Postgres generates the `users.id` uuid (generateId returns false for that
 * model); Better Auth generates uuids for session/account/verification.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { phoneNumber } from 'better-auth/plugins/phone-number';
import { bearer } from 'better-auth/plugins/bearer';
import * as schema from '@twenty4/contracts/db';

import { db } from '../db/index.js';
import { env } from '../env.js';
import { sendOtp } from './otpTransport.js';
import { betterAuthSocialConfig } from './socialProviders.js';

/** 30 days — long-lived mobile sessions; revocable server-side at any time. */
const SESSION_EXPIRES_IN = 60 * 60 * 24 * 30;

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // The handler is mounted at /auth/* in app.ts.
  basePath: '/auth',
  trustedOrigins: ['twenty4://', env.BETTER_AUTH_URL],

  database: drizzleAdapter(db, {
    provider: 'pg',
    // Map Better Auth's logical models onto our concrete Drizzle tables.
    schema: {
      ...schema,
      user: schema.users,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),

  // We are OTP/social-only — no password credential flow.
  emailAndPassword: { enabled: false },

  // Map the Better Auth `user` model onto the existing `users` table + columns.
  // IMPORTANT: with the drizzle adapter, `fields`/`fieldName` values are the
  // DRIZZLE SCHEMA PROPERTY NAMES (camelCase), not the SQL column names — the
  // adapter resolves the actual column off the Drizzle table by that key.
  user: {
    modelName: 'users',
    fields: {
      name: 'displayName',
      image: 'profilePhotoUrl',
      email: 'email',
      emailVerified: 'emailVerified',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    },
    // Surface twenty4-owned columns to the adapter; input:false ⇒ not user-settable
    // through Better Auth (the app's PATCH /users/me owns them).
    additionalFields: {
      username: { type: 'string', required: false, input: false },
      authProvider: {
        type: 'string',
        required: false,
        input: false,
        fieldName: 'authProvider',
      },
      accountStatus: {
        type: 'string',
        required: false,
        input: false,
        fieldName: 'accountStatus',
      },
    },
  },

  session: {
    modelName: 'session',
    fields: { userId: 'userId', expiresAt: 'expiresAt' },
    expiresIn: SESSION_EXPIRES_IN,
    updateAge: 60 * 60 * 24, // refresh sliding window daily
  },

  account: {
    modelName: 'account',
    fields: { userId: 'userId' },
  },

  verification: {
    modelName: 'verification',
  },

  advanced: {
    database: {
      // Let Postgres generate the users.id uuid; Better Auth generates uuids for
      // session/account/verification (so their text-free uuid PKs are satisfied).
      generateId: (options: { model: string }) =>
        options.model === 'user' || options.model === 'users'
          ? false
          : crypto.randomUUID(),
    },
  },

  socialProviders: betterAuthSocialConfig(),

  plugins: [
    // REAL email OTP. The transport logs + caches the code in dev (retrievable by
    // tests / the dev-only route) and is a prod TODO stub.
    emailOTP({
      otpLength: 6,
      expiresIn: 600,
      // Auto-create + sign in a user on first valid sign-in OTP.
      sendVerificationOnSignUp: false,
      async sendVerificationOTP({ email, otp, type }) {
        await sendOtp({ channel: 'email', identifier: email, code: otp, type });
      },
    }),
    // REAL phone OTP (same pluggable transport). Map the plugin's user fields
    // onto our existing columns (Drizzle property names): phoneNumber → phone,
    // phoneNumberVerified → phoneNumberVerified.
    phoneNumber({
      otpLength: 6,
      expiresIn: 600,
      schema: {
        user: {
          fields: {
            phoneNumber: 'phone',
            phoneNumberVerified: 'phoneNumberVerified',
          },
        },
      },
      // First-time phone sign-in auto-creates the user. Better Auth's user create
      // requires a `name` + `email`, so we synthesize non-routable placeholders
      // from the phone number; the real handle/display are set at profile-setup.
      // The synthetic email is clearly non-deliverable (.invalid TLD, RFC 6761).
      signUpOnVerification: {
        getTempEmail: (phone) =>
          `phone-${phone.replace(/[^\d]/g, '')}@phone.twenty4.invalid`,
        getTempName: (phone) => phone,
      },
      async sendOTP({ phoneNumber: phone, code }) {
        await sendOtp({ channel: 'phone', identifier: phone, code });
      },
    }),
    // Return/accept the session token via `Authorization: Bearer` + set-auth-token.
    bearer(),
  ],
});

export type Auth = typeof auth;
/** The session shape Better Auth resolves (`{ session, user }` or null). */
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
