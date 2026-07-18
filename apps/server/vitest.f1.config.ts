import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.f1.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
