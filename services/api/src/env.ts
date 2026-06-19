/**
 * Environment configuration — zod-validated, fail-fast.
 *
 * Parses `process.env` once into a typed, frozen `env` object. On invalid/missing
 * vars we print a readable, grouped error and `process.exit(1)` so the server
 * never boots half-configured.
 *
 * Slice 0 keeps `BETTER_AUTH_SECRET` optional (auth lands in Slice 3).
 */
import { z } from 'zod';

/** Coerce common truthy/falsey string forms into a boolean. */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  });

const envSchema = z.object({
  // --- Database (postgres.js) ---
  DATABASE_URL: z.string().url(),

  // --- Redis (ioredis / BullMQ) ---
  REDIS_URL: z.string().url(),

  // --- Object storage (S3-compatible / MinIO) ---
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: boolish.default(true),
  S3_BUCKET_RAW: z.string().min(1).default('raw'),
  S3_BUCKET_MONTAGES: z.string().min(1).default('montages'),
  S3_BUCKET_THUMBNAILS: z.string().min(1).default('thumbnails'),

  // --- Server (Fastify) ---
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),

  // --- Auth (Better Auth) ---
  // Signing secret for sessions/tokens. Dev default keeps local/test bootable;
  // production MUST override (a startup guard below rejects the dev default in prod).
  BETTER_AUTH_SECRET: z
    .string()
    .min(1)
    .default('dev-only-insecure-better-auth-secret-change-me'),
  // Public base URL Better Auth uses to build its routes (mounted under /auth).
  BETTER_AUTH_URL: z.string().url().default('http://127.0.0.1:4000'),

  // --- Admin (Slice 8 moderation/ops) ---
  // Comma-separated allowlist of admin emails. On sign-in, a user whose email is
  // in this list is promoted to `is_admin` (seeded), gating the /admin/* surface.
  // Empty by default → no admins until configured (least privilege).
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),

  // --- App behavior ---
  // 4am→4am day window: floor((utc − DAY_WINDOW_OFFSET_HOURS) in device tz).
  DAY_WINDOW_OFFSET_HOURS: z.coerce.number().int().min(0).max(23).default(4),

  // Post-upload size cap (bytes). The presigned PUT can't enforce size up-front, so
  // POST /media/:id/complete HeadObjects the landed object and rejects (+ deletes)
  // anything over this. Defaults to the §10 200MB/item limit; overridable (e.g.
  // tests set a tiny cap to exercise the gate on real, small bytes).
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(200 * 1024 * 1024),

  // Minimum number of VALID daily_media_item rows required in today's bucket
  // before a montage can be generated (configurable). Default 1 (the loop is
  // demoable with a single item; a higher floor is a product knob).
  MONTAGE_MIN_VALID_MEDIA: z.coerce.number().int().min(1).default(1),

  // Montage content lifetime once published (§6: 24h). Configurable for tests.
  MONTAGE_LIFETIME_HOURS: z.coerce.number().int().positive().default(24),

  // Grace period before the raw-media purge runs after publish (§6 Q5: +60min).
  RAW_PURGE_GRACE_MINUTES: z.coerce.number().int().min(0).default(60),

  // Per-IP OTP-send cap (hits / 10-min window). Defense-in-depth on TOP of the
  // strict per-IDENTIFIER cap (which is the real brute-force/enumeration defense
  // and stays fixed at OTP_SEND_MAX). Configurable because the per-IP dimension
  // is a COARSE abuse-shaper that legitimately needs raising behind shared NAT /
  // CI: in the api vitest suite every file's beforeAll signs up many users from
  // the test host IP, so a low per-IP cap would exhaust cumulatively across files
  // in one run and 429 later files. Set high under test (see vitest.config.ts) to
  // make the suite deterministic WITHOUT weakening the per-identifier guarantee
  // the security tests assert. Default matches the strict prod value (5).
  OTP_SEND_IP_MAX: z.coerce.number().int().positive().default(5),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(
      `\n[twenty4/api] Invalid environment configuration:\n${issues}\n\n` +
        `Fix the variables above (see .env.example) and restart.\n`,
    );
    process.exit(1);
  }
  // Refuse to boot in production with the insecure dev auth secret.
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.BETTER_AUTH_SECRET === 'dev-only-insecure-better-auth-secret-change-me'
  ) {
    // eslint-disable-next-line no-console
    console.error(
      '\n[twenty4/api] BETTER_AUTH_SECRET must be set to a real secret in production.\n',
    );
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const env: Env = loadEnv();
