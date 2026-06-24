// @twenty4/contracts — shared Zod env schema.
// Single source of truth for the environment every service parses at startup.
// Services call parseEnv() and fail fast on a non-conforming environment.
import { z } from "zod";

// Coerce a string env var into an int port, with sane bounds.
const port = z.coerce.number().int().min(1).max(65535);

export const envSchema = z.object({
  // Runtime.
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Database (Postgres) — postgres.js connection string.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Redis — used by BullMQ / rate-limit later (M2+). Required for the scaffold.
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // Object storage (MinIO / S3).
  S3_ENDPOINT: z.string().min(1, "S3_ENDPOINT is required"),
  S3_ACCESS_KEY: z.string().min(1, "S3_ACCESS_KEY is required"),
  S3_SECRET_KEY: z.string().min(1, "S3_SECRET_KEY is required"),
  S3_REGION: z.string().min(1, "S3_REGION is required"),
  S3_BUCKET_RAW: z.string().min(1, "S3_BUCKET_RAW is required"),
  S3_BUCKET_MONTAGES: z.string().min(1, "S3_BUCKET_MONTAGES is required"),
  S3_BUCKET_THUMBNAILS: z.string().min(1, "S3_BUCKET_THUMBNAILS is required"),

  // API server.
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: port.default(3000),

  // Email — Mailpit (dev) optional, SES (prod) optional. Wired in M2.
  MAILPIT_HOST: z.string().optional(),
  MAILPIT_PORT: port.optional(),
  SES_FROM_EMAIL: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  // ── Auth (M2) ──────────────────────────────────────────────────────────────
  // Better Auth signing secret. Dev default is a placeholder the prod-secret
  // guard rejects (contains "secret"/"dev"), keeping M1's fail-fast honest while
  // letting dev/test boot with no extra config.
  BETTER_AUTH_SECRET: z.string().min(1).default("dev-better-auth-secret-change-me"),
  // Comma-separated admin emails seeded to is_admin=true.
  ADMIN_EMAILS: z.string().default(""),
  // OTP throttle caps (env-configurable so CI is deterministic).
  OTP_MAX_PER_IP: z.coerce.number().int().min(1).default(20),
  OTP_MAX_PER_IDENTIFIER: z.coerce.number().int().min(1).default(5),
  OTP_WINDOW_SEC: z.coerce.number().int().min(1).default(900),
  OTP_VERIFY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  // Double-gate the dev last-otp route (defaults to dev-on / prod-off via NODE_ENV).
  ENABLE_DEV_OTP_ROUTE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

export type Env = z.infer<typeof envSchema>;

// The fields treated as "secrets" for the prod placeholder guard.
export const SECRET_ENV_KEYS = [
  "DATABASE_URL",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "BETTER_AUTH_SECRET",
] as const satisfies readonly (keyof Env)[];

// Known dev/placeholder values that must NEVER be used as a prod secret.
export const PLACEHOLDER_SECRETS = ["minioadmin", "twenty4", "changeme", "password", "secret", "admin"];

// Parse + validate the given source (defaults to process.env).
// Throws a ZodError on failure — callers (services) decide how to fail fast.
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  return envSchema.parse(source);
}

// A safe variant returning the Zod SafeParseReturn for callers that want to
// format the error themselves before exiting.
export function safeParseEnv(source: Record<string, string | undefined> = process.env) {
  return envSchema.safeParse(source);
}

// Prod-secret guard: in production, refuse known dev/placeholder secret values.
// Returns the list of offending env keys (empty when clean). Services throw on a
// non-empty result before listen.
export function findPlaceholderSecrets(env: Env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const offenders: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) {
      offenders.push(key);
      continue;
    }
    const lower = value.toLowerCase();
    if (PLACEHOLDER_SECRETS.some((p) => lower.includes(p))) {
      offenders.push(key);
    }
  }
  return offenders;
}
