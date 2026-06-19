/**
 * Worker environment — zod-validated, fail-fast (mirrors the API's env.ts but only
 * the vars the worker needs: PG, Redis, S3/MinIO, day-window offset).
 */
import { z } from 'zod';

const boolish = z.union([z.boolean(), z.string()]).transform((v) => {
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
});

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: boolish.default(true),
  S3_BUCKET_RAW: z.string().min(1).default('raw'),
  S3_BUCKET_MONTAGES: z.string().min(1).default('montages'),
  S3_BUCKET_THUMBNAILS: z.string().min(1).default('thumbnails'),

  /** 4am→4am day window (must match the API's value). */
  DAY_WINDOW_OFFSET_HOURS: z.coerce.number().int().min(0).max(23).default(4),

  /**
   * Post-upload size cap (bytes) — MUST mirror the API's `MAX_UPLOAD_BYTES` so the
   * worker enforces the SAME §10 ceiling when it downloads. The effective cap is
   * `min(this, §10 200MB)` (see `MAX_DOWNLOAD_BYTES`), so the env can only ever
   * TIGHTEN the limit, never loosen it past the §10 hard limit. Tests set a tiny
   * cap to exercise the worker-side download guard on real small bytes.
   */
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(200 * 1024 * 1024),

  /**
   * Anti-tamper threshold (minutes): if |deviceClock − serverReceiveTime| exceeds
   * this, the item's `device_time_suspicious` flag is set (§6).
   */
  DEVICE_TIME_SUSPICIOUS_MINUTES: z.coerce.number().int().min(1).default(60),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type WorkerEnv = z.infer<typeof envSchema>;

function loadEnv(): WorkerEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`\n[twenty4/worker] Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const env: WorkerEnv = loadEnv();
