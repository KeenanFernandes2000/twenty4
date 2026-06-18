import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The gate renders real MP4s headlessly — generous timeouts, no parallelism.
    include: ['test/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
