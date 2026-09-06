// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/protocol/schemas/**',
      'tools/skills/__fixtures__/**',
      '.changeset/**',
      'examples/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The protocol boundary is validated at runtime by Zod; an unused
      // parameter is still a defect worth surfacing, but `_`-prefixed names
      // are the documented opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Consistency with `verbatimModuleSyntax`.
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
    },
  },

  {
    // Public packages must not leak `any` or silence the checker. These are the
    // surfaces consumers actually depend on.
    files: ['packages/*/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use a Zod enum plus `z.infer`; TS enums are not erasable and drift from the wire contract.',
        },
        {
          selector: 'ImportDeclaration[source.value=/^@relvo-labs\\/[^/]+\\/(?!testing$)/]',
          message: 'Deep imports are forbidden. Import from a declared package entry point.',
        },
      ],
    },
  },

  {
    // Tooling runs directly under Node; console output is its interface.
    files: ['tools/**/*.ts', '*.config.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    files: ['**/*.test.ts', 'packages/*/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },

  prettier,
);
