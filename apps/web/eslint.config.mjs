import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
});

const eslintConfig = [
  ...compat.config({
    extends: ['next/core-web-vitals', 'next/typescript'],
    settings: {
      next: {
        rootDir: import.meta.dirname,
      },
    },
  }),
  {
    ignores: ['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'playwright-report/**', 'test-results/**'],
  },
];

export default eslintConfig;
