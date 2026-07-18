// Flat ESLint config (ESLint 9) — shared root config.
// App-specific configs (Next.js, Nest) extend/augment within each workspace.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      '**/migrations/**',
      '**/*.config.{js,mjs,cjs}',
      '**/*.config.ts',
    ],
  },

  // Base JS rules for all files
  js.configs.recommended,

  // TypeScript files — use TS parser + recommended rules
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    linterOptions: {
      // Don't fail on stale eslint-disable directives left in source code
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      // Allow @ts-comment directives (ts-ignore, ts-expect-error, etc.)
      '@typescript-eslint/ban-ts-comment': 'off',
      // Unused vars: warn only, ignore leading-underscore names
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Relax common NestJS / iterative-dev patterns
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      // Turn off base rule in favour of TS-aware version
      'no-unused-vars': 'off',
      'no-undef': 'off',
      // Allow intentional empty catch blocks
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Plain JS/MJS files — browser + node globals, no TS parser
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        URL: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
      // Allow intentional empty catch blocks in scripts
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Test specs — mocks legitimately use `any`; relax noise rules here
  {
    files: ['**/*.spec.ts', '**/*.int-spec.ts', '**/*.e2e-spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // k6 load-test scripts — k6 ships its own globals (__ENV, __VU, __ITER)
  {
    files: ['**/k6/**/*.js'],
    languageOptions: {
      globals: {
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
    },
  },
);
