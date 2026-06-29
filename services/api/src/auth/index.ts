// Auth subsystem assembly — wires BA + email + OTP transport + rate limiter +
// admin seed, and registers the /auth + /users routes on a Fastify instance.
// buildApp() calls registerAuth() once the DB + Redis clients exist.
import type { FastifyInstance } from "fastify";
import type { Env } from "@twenty4/contracts";
import { buildAuth, type Auth } from "./betterAuth.ts";
import { parseAdminEmails, reconcileAdmins } from "./adminSeed.ts";
import { createOtpRateLimiter } from "./otpRateLimit.ts";
import { createOtpTransport, type OtpTransport } from "./otpTransport.ts";
import { registerAuthRoutes } from "./routes.ts";
import type { CleanupQueues } from "../cleanup/queue.ts";
import type { DbClient } from "../db.ts";
import type { RedisClient } from "../redis.ts";
import { createEmailService, type EmailService } from "../services/email.service.ts";

export interface RegisterAuthDeps {
  db: DbClient;
  redis: RedisClient;
  env: Env;
  // M9 cleanup queues — DELETE /users/me enqueues purge-account. Optional so an
  // M1-only test can still register auth (the enqueue helper no-ops on undefined).
  cleanupQueues?: CleanupQueues;
}

export interface AuthSubsystem {
  auth: Auth;
  email: EmailService;
  otp: OtpTransport;
}

export async function registerAuth(app: FastifyInstance, deps: RegisterAuthDeps): Promise<AuthSubsystem> {
  const { db, redis, env } = deps;

  const email = createEmailService({
    nodeEnv: env.NODE_ENV,
    mailpitHost: env.MAILPIT_HOST,
    mailpitPort: env.MAILPIT_PORT,
    sesFromEmail: env.SES_FROM_EMAIL,
    awsRegion: env.AWS_REGION,
  });

  const otp = createOtpTransport({ redis, email, ttlMinutes: Math.round(env.OTP_WINDOW_SEC / 60) || 10 });

  const auth = buildAuth({ db, secret: env.BETTER_AUTH_SECRET, otp });

  const rateLimiter = createOtpRateLimiter(redis, {
    maxPerIp: env.OTP_MAX_PER_IP,
    maxPerIdentifier: env.OTP_MAX_PER_IDENTIFIER,
    windowSec: env.OTP_WINDOW_SEC,
    verifyMaxAttempts: env.OTP_VERIFY_MAX_ATTEMPTS,
  });

  const adminEmails = parseAdminEmails(env.ADMIN_EMAILS);

  // Boot reconciliation pass — make is_admin match ADMIN_EMAILS.
  await reconcileAdmins(db, adminEmails).catch((err) => {
    app.log.error({ err }, "admin reconciliation failed (non-fatal)");
  });

  await registerAuthRoutes(app, {
    auth,
    db,
    otp,
    rateLimiter,
    adminEmails,
    nodeEnv: env.NODE_ENV,
    enableDevOtpRoute: env.ENABLE_DEV_OTP_ROUTE,
    cleanupQueues: deps.cleanupQueues,
  });

  return { auth, email, otp };
}
