// @twenty4/contracts — shared Zod env schema.
// Single source of truth for the environment every service parses at startup.
// Services call parseEnv() and fail fast on a non-conforming environment.
import { z } from "zod";
import { MONTAGE_MIN_MEDIA } from "../dto/montage.ts";
import { COMMENT_MAX_LENGTH } from "../dto/social.ts";

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
  // Bucket reported-content snapshots are stored in (M9 snapshot-purge-sweep).
  // Optional → resolves to S3_BUCKET_THUMBNAILS at the worker wiring site (snapshots
  // are small image blobs), mirroring S3_PUBLIC_ENDPOINT's default-at-use idiom.
  // M12 COUPLING TRAP: the report-WRITE flow MUST store snapshots in THIS bucket or
  // sweepSnapshotPurge cannot reclaim them — pin it explicitly when M12 lands.
  SNAPSHOT_BUCKET: z.string().optional(),
  // ── Media presign (M4) ──────────────────────────────────────────────────────
  // THE v1 lesson: SigV4 signs the Host header, so a presigned URL signed against
  // `localhost` is unusable from the phone. The S3 client that SIGNS presigned
  // PUT/GET URLs uses S3_PUBLIC_ENDPOINT (the LAN/Tailscale host the device hits);
  // server-side ops (HeadObject/DeleteObject) use the internal S3_ENDPOINT.
  // Defaults to S3_ENDPOINT when unset so M1 fail-fast / single-host dev still works.
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  // Presigned-URL TTLs (seconds). Bounded by content lifetime; short by default.
  MEDIA_UPLOAD_URL_TTL_SEC: z.coerce.number().int().min(1).default(900),
  MEDIA_DOWNLOAD_URL_TTL_SEC: z.coerce.number().int().min(1).default(900),
  // Raw-media safety-backstop TTL in hours (M9 owns the authoritative purge). Sets
  // expiry_at on the row at init. Default ~26h.
  MEDIA_RAW_TTL_HOURS: z.coerce.number().int().min(1).default(26),
  // Per-item byte cap enforced at /complete via HeadObject. Default 200 MB. Env-
  // overridable so a test can set a tiny cap and exercise the over-size reject
  // path deterministically without a 200MB upload.
  MEDIA_MAX_BYTES: z.coerce.number().int().min(1).default(200 * 1024 * 1024),
  // Per-day item cap enforced at init. Default 50. Env-overridable for tests.
  MEDIA_MAX_ITEMS_PER_DAY: z.coerce.number().int().min(1).default(50),

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

  // ── Invite throttle caps (M3) ───────────────────────────────────────────────
  // Per-(user) fixed-window caps on invite create + join, env-configurable so CI
  // can set low caps for deterministic 429 tests (the §5 OTP-cap learning applied
  // to invites). Optional-with-defaults so M1 fail-fast still passes.
  INVITE_CREATE_CAP: z.coerce.number().int().min(1).default(30),
  INVITE_JOIN_CAP: z.coerce.number().int().min(1).default(60),
  INVITE_WINDOW_SEC: z.coerce.number().int().min(1).default(900),

  // ── Montage render (M7) ─────────────────────────────────────────────────────
  // Worker-side Remotion render knobs. Concurrency 1 for the single-worker
  // prototype (env-overridable to tune the gate's p95). RENDER_GL is the literal
  // string "null" → maps to chromiumOptions.gl = null (~9× faster than 'angle';
  // PHASE1 recap §8.6). MEDIA_SERVER_PORT=0 = ephemeral (OS-assigned) port.
  // MONTAGE_MIN_MEDIA is the N floor of valid items required to generate.
  // INFRA_REMOTION_DIR locates the render driver + bundled music manifest.
  REMOTION_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  RENDER_TIMEOUT_MS: z.coerce.number().int().min(1).default(300000),
  RENDER_GL: z.string().default("null"),
  MEDIA_SERVER_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  MONTAGE_MIN_MEDIA: z.coerce.number().int().min(1).default(MONTAGE_MIN_MEDIA),
  INFRA_REMOTION_DIR: z.string().default("infra/remotion"),

  // ── Feed + social throttle/limits (M8) ──────────────────────────────────────
  // Per-(user) fixed-window caps on comment-create + reaction-set, env-configurable
  // so CI can set low caps for deterministic 429 tests (the §5 OTP-cap learning).
  // COMMENT_MAX_LENGTH defaults to the dto constant; CI can set a low cap to drive
  // the over-length reject path. Optional-with-defaults so M1 fail-fast still passes.
  COMMENT_CREATE_CAP: z.coerce.number().int().min(1).default(10),
  COMMENT_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
  COMMENT_MAX_LENGTH: z.coerce.number().int().min(1).default(COMMENT_MAX_LENGTH),
  REACTION_SET_CAP: z.coerce.number().int().min(1).default(30),
  REACTION_WINDOW_SEC: z.coerce.number().int().min(1).default(60),

  // ── Ephemerality / 24h hard-delete (M9) ─────────────────────────────────────
  // ALL overridable so the §6 deletion suite runs a "24h" contract in seconds
  // against the live stack. Units are as named (hours / minutes / seconds).
  //  - MONTAGE_EXPIRY_HOURS:        published_at + this = expiry_at (the contract).
  //  - MONTAGE_EXPIRY_SEC:          OPTIONAL sub-hour override; when set it WINS over
  //                                 HOURS (published_at + this seconds = expiry_at), so
  //                                 on-device acceptance (~2-min lifetime, spec §8) and
  //                                 the §7 "24h expiry in seconds" run on the real path.
  //  - RAW_PURGE_GRACE_MIN:         delay after publish before raw-media purge.
  //  - SWEEP_*_INTERVAL_SEC:        repeatable reclaim-sweep cadences (lost-job backstops).
  //  - SNAPSHOT_RETENTION_HOURS:    report snapshot retain window (default 7d) — the
  //                                 slice-8 PII hole; drives snapshot-purge-sweep.
  MONTAGE_EXPIRY_HOURS: z.coerce.number().int().min(1).default(24),
  // Optional sub-hour override (seconds). Undefined when unset → falls back to HOURS.
  MONTAGE_EXPIRY_SEC: z.coerce.number().int().min(1).optional(),
  RAW_PURGE_GRACE_MIN: z.coerce.number().int().min(1).default(60),
  SWEEP_EXPIRIES_INTERVAL_SEC: z.coerce.number().int().min(1).default(180),
  SWEEP_RAW_PURGE_INTERVAL_SEC: z.coerce.number().int().min(1).default(180),
  SWEEP_DAY_CLOSE_INTERVAL_SEC: z.coerce.number().int().min(1).default(1800),
  SWEEP_SNAPSHOT_PURGE_INTERVAL_SEC: z.coerce.number().int().min(1).default(1800),
  SNAPSHOT_RETENTION_HOURS: z.coerce.number().int().min(1).default(168),
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
