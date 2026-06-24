// Better Auth configuration — Drizzle adapter on our Postgres, sharing the single
// physical drizzle-orm copy pinned in M0. Plugins: phoneNumber, emailOTP, bearer.
//
// v1 gotchas applied (PHASE1_WORK_RECAP.md §5):
//  - Field mapping uses Drizzle PROPERTY names (our schema already names props
//    `displayName`/`emailVerified`/`userId`/… to match BA), with explicit field
//    maps where the BA concept differs from our column (name→displayName,
//    image→profilePhotoUrl).
//  - advanced.generateId special-cases user/users → false so PG generates the
//    uuid (gen_random_uuid()); BA generates ids for session/account/verification.
//  - phoneNumber.signUpOnVerification.getTempEmail/getTempName avoid the 500 on
//    phone-only signup.
//  - OTP transport: emailOTP.sendVerificationOTP → our EmailService (awaited,
//    failure surfaced); phoneNumber.sendOTP → dev console + Redis dev store.
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP, phoneNumber } from "better-auth/plugins";
import * as schema from "@twenty4/contracts/db";
import type { DbClient } from "../db.ts";
import type { OtpTransport } from "./otpTransport.ts";

export interface BuildAuthOptions {
  db: DbClient;
  secret: string;
  otp: OtpTransport;
  otpLength?: number;
  otpExpirySec?: number;
}

export type Auth = ReturnType<typeof buildAuth>;

export function buildAuth(opts: BuildAuthOptions) {
  const { db, secret, otp } = opts;
  const otpLength = opts.otpLength ?? 6;
  const expiresIn = opts.otpExpirySec ?? 600;

  const options = {
    secret,
    // baseURL: in-process auth.api.* calls don't need a real origin; set a stable
    // localhost value to silence BA's derive-from-request warning.
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    // Disable BA's own rate limiter — we front everything with our /auth façade +
    // Redis throttle, and the raw BA OTP HTTP routes are deny-listed (403).
    rateLimit: { enabled: false },
    database: drizzleAdapter(db.db, {
      provider: "pg",
      // Bind BA's logical models to our Drizzle tables.
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    // Map BA's `user` concept onto our extra columns. Property names (Drizzle),
    // not SQL columns.
    user: {
      modelName: "user",
      fields: {
        // BA's `name` → our displayName property; BA's `image` → profilePhotoUrl.
        name: "displayName",
        image: "profilePhotoUrl",
      },
    },
    session: {
      modelName: "session",
      fields: { userId: "userId" },
      expiresIn: 60 * 60 * 24 * 30, // 30d
      updateAge: 60 * 60 * 24, // refresh window
    },
    account: {
      modelName: "account",
      fields: { userId: "userId" },
    },
    verification: { modelName: "verification" },
    advanced: {
      database: {
        // Let PG own the user uuid (gen_random_uuid()); generate uuids for the
        // other tables so BA's default short id isn't fed to our uuid columns.
        // Lives under advanced.database.generateId in BA 1.6 (NOT advanced.generateId).
        generateId: (props: { model: string }) => {
          if (props.model === "user" || props.model === "users") return false;
          return crypto.randomUUID();
        },
      },
    },
    plugins: [
      phoneNumber({
        otpLength,
        expiresIn,
        // Map the plugin's user fields onto our Drizzle property names: the plugin
        // wants `phoneNumber`/`phoneNumberVerified` on user; our property is `phone`
        // (+ `phoneNumberVerified`). Field maps use Drizzle PROPERTY names (v1 §5).
        schema: {
          user: {
            fields: {
              phoneNumber: "phone",
              phoneNumberVerified: "phoneNumberVerified",
            },
          },
        },
        sendOTP: async ({ phoneNumber: phone, code }) => {
          // Dev console + Redis dev store (read by /auth/dev/last-otp). Real SMS = M15.
          await otp.writePhoneDevOtp(phone, code);
        },
        signUpOnVerification: {
          // Phone-only signup needs a temp email/name or BA 500s (v1 §5).
          getTempEmail: (phone) => `phone-${phone.replace(/[^0-9]/g, "")}@phone.twenty4.invalid`,
          getTempName: (phone) => phone,
        },
      }),
      emailOTP({
        otpLength,
        expiresIn,
        // Allow OTP to create the account on first verify (sign-in flow).
        disableSignUp: false,
        sendVerificationOTP: async ({ email, otp: code }) => {
          // Awaited + throws on failure → the façade surfaces a 5xx (not silent).
          await otp.send({ channel: "email", identifier: email, code });
        },
      }),
      bearer(),
    ],
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}
