import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Env is zod-validated at import; provide minimal valid values so `env.ts`
    // doesn't process.exit(1) when a module that imports it loads under test.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://twenty4@127.0.0.1:5433/twenty4',
      REDIS_URL: 'redis://127.0.0.1:6379',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
      S3_FORCE_PATH_STYLE: 'true',
      S3_BUCKET_RAW: 'raw',
      S3_BUCKET_MONTAGES: 'montages',
      S3_BUCKET_THUMBNAILS: 'thumbnails',
      PORT: '4000',
      HOST: '0.0.0.0',
    },
  },
});
