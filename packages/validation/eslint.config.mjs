import { nodeConfig } from '@pay2all/config/eslint';

export default [
  ...nodeConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // Bundled into the browser by apps/web: Node built-ins crash the client (the login page did once).
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: 'This package runs in the browser too; Node built-ins are not available there.' }] }],
    },
  },
];
