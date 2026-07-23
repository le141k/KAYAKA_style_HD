import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.int-spec.ts'],
    // Fixtures intentionally pin and then restore process.env before dynamically
    // importing AppModule. Run files serially so a future fixture cannot race that
    // isolation boundary or share an external dependency by accident.
    isolate: true,
    fileParallelism: false,
    // Integration tests can be slow (Testcontainers + migrations)
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.int-spec.ts', 'src/seed/**'],
    },
  },
  // NestJS DI relies on emitDecoratorMetadata. Vitest's default esbuild transform drops it,
  // so constructor injection resolves to `undefined`. SWC re-emits decorator metadata.
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
});
