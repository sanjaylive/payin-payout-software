// Shared ESLint flat config for Pay2All packages and Node apps.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Rules that protect security/financial invariants across the codebase. */
const safetyRules = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "MemberExpression[property.name='$queryRawUnsafe']",
      message: 'Use tagged $queryRaw templates; $queryRawUnsafe allows SQL injection.',
    },
    {
      selector: "MemberExpression[property.name='$executeRawUnsafe']",
      message: 'Use tagged $executeRaw templates; $executeRawUnsafe allows SQL injection.',
    },
    {
      selector: "CallExpression[callee.name='parseFloat']",
      message: 'Never parse money with parseFloat. Use the money helpers in @pay2all/ledger.',
    },
  ],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
  ],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-console': 'error',
};

/**
 * @param {{ tsconfigRootDir: string, nest?: boolean }} options
 */
export function nodeConfig({ tsconfigRootDir, nest = false }) {
  return tseslint.config(
    { ignores: ['dist/**', 'generated/**', 'coverage/**', '*.config.*', 'eslint.config.mjs'] },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        globals: { ...globals.node },
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        ...safetyRules,
        // NestJS DI relies on runtime class references in constructor params;
        // type-only imports would break emitDecoratorMetadata.
        ...(nest ? { '@typescript-eslint/consistent-type-imports': 'off' } : {}),
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': 'error',
        '@typescript-eslint/require-await': 'off',
        '@typescript-eslint/no-extraneous-class': 'off',
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      },
    },
    {
      files: ['**/*.spec.ts', '**/*.test.ts', 'test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/unbound-method': 'off',
      },
    },
    prettier,
  );
}

export { safetyRules };
