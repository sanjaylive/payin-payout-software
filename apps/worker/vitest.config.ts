import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
      { test: { name: 'integration', include: ['src/**/*.int-spec.ts'], globalSetup: ['src/test-global-setup.ts'], testTimeout: 60_000, fileParallelism: false } },
    ],
  },
});
