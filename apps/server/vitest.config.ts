import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests are run through vitest.integration.config.ts so they
    // can use fileParallelism: false. The default config runs unit tests only.
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
