import { nodeConfig } from '@pay2all/config/eslint';

export default [
  ...nodeConfig({ tsconfigRootDir: import.meta.dirname }),
  { ignores: ['src/generated/**', 'prisma/**', 'prisma.config.ts'] },
];
