import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required so NestJS decorator metadata (emitDecoratorMetadata) exists at test time.
const swcPlugin = swc.vite({ module: { type: 'es6' } });

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [swcPlugin],
        test: { name: 'unit', include: ['src/**/*.spec.ts'], globals: true },
      },
      {
        plugins: [swcPlugin],
        test: {
          name: 'integration',
          include: ['test/**/*.e2e-spec.ts'],
          globals: true,
          globalSetup: ['test/global-setup.ts'],
          setupFiles: ['test/setup-env.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // Integration tests share one database; run files sequentially.
          fileParallelism: false,
        },
      },
    ],
  },
});
