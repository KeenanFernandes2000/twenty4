// OTP transport — routes a code to the user by channel.
//  - email → EmailService.sendOtpEmail (awaited; failure surfaces to the caller —
//    OTP send is NOT fire-and-forget; the user must learn if it failed).
//  - phone → dev console transport + a Redis dev store (`otp:<identifier>` TTL
//    600s) read by GET /auth/dev/last-otp. Real SMS is deferred to M15.
//
// NOTE: phone OTP is plaintext-at-rest in the Redis dev store (accepted P1 limit,
// matching BA's verification store). Email OTP is hashed at rest by Better Auth.
import type { Channel } from "@twenty4/contracts";
import type { RedisClient } from "../redis.ts";
import type { EmailService } from "../services/email.service.ts";

// Dev store TTL for the last phone OTP (seconds).
const DEV_OTP_TTL_SEC = 600;
const devOtpKey = (identifier: string) => `otp:${identifier}`;

export interface OtpTransportDeps {
  redis: RedisClient;
  email: EmailService;
  // OTP validity window surfaced in the email copy.
  ttlMinutes: number;
}

export interface OtpTransport {
  send(args: { channel: Channel; identifier: string; code: string }): Promise<void>;
  // Read the last phone OTP from the dev store (for GET /auth/dev/last-otp).
  readDevOtp(identifier: string): Promise<string | null>;
  // Write a phone OTP to the dev store + console (used by BA's phone sendOTP).
  writePhoneDevOtp(identifier: string, code: string): Promise<void>;
}

export function createOtpTransport(deps: OtpTransportDeps): OtpTransport {
  const { redis, email, ttlMinutes } = deps;

  async function writePhoneDevOtp(identifier: string, code: string): Promise<void> {
    // Dev console transport (stand-in for SMS until M15).
    console.log(`[otp:phone] ${identifier} → code ${code} (dev console transport)`);
    await redis.set(devOtpKey(identifier), code, "EX", DEV_OTP_TTL_SEC);
  }

  return {
    async send({ channel, identifier, code }) {
      if (channel === "email") {
        // Await + surface failure (caller maps a throw to a 5xx/INTERNAL envelope).
        await email.sendOtpEmail(identifier, { code, ttlMinutes });
        return;
      }
      // phone
      await writePhoneDevOtp(identifier, code);
    },

    async readDevOtp(identifier) {
      return redis.get(devOtpKey(identifier));
    },

    writePhoneDevOtp,
  };
}
