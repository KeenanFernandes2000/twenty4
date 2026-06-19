import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Env is zod-validated at import; provide minimal valid values so `env.ts`
    // doesn't process.exit(1) when a module that imports it loads under test.
    // Prefer the live values sourced from ~/.twenty4-dev-env.sh (real PG role,
    // Redis, MinIO) so integration tests hit the live stack; fall back to the
    // documented local defaults for anything not exported.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/twenty4',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      S3_REGION: process.env.S3_REGION ?? 'us-east-1',
      S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'minioadmin',
      S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'minioadmin',
      S3_FORCE_PATH_STYLE: 'true',
      // Tighten the post-upload size cap to 1KB so the oversize gate can be
      // exercised on REAL small bytes (a ~2KB upload trips it) without moving
      // 200MB. The route clamps to min(env, §10 200MB), so this only tightens.
      MAX_UPLOAD_BYTES: '1024',
      S3_BUCKET_RAW: 'raw',
      S3_BUCKET_MONTAGES: 'montages',
      S3_BUCKET_THUMBNAILS: 'thumbnails',
      PORT: '4000',
      HOST: '0.0.0.0',
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET ?? 'dev-only-insecure-better-auth-secret-change-me',
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:4000',
    },
  },
});
