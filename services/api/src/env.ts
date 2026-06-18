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

  // --- Auth (Better Auth) — optional in Slice 0, required from Slice 3 ---
  BETTER_AUTH_SECRET: z.string().min(1).optional(),

  // --- App behavior ---
  // 4am→4am day window: floor((utc − DAY_WINDOW_OFFSET_HOURS) in device tz).
  DAY_WINDOW_OFFSET_HOURS: z.coerce.number().int().min(0).max(23).default(4),

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
  return Object.freeze(parsed.data);
}

export const env: Env = loadEnv();
