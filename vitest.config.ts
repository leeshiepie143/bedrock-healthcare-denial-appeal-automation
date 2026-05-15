import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@lambdas': path.resolve(__dirname, 'src/lambdas'),
      '@infra': path.resolve(__dirname, 'infra'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'infra/**/*.ts'],
      exclude: ['**/*.d.ts', '**/index.ts'],
    },
    testTimeout: 30000,
  },
});
