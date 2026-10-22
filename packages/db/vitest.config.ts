import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Each file provisions its own database; 30s covers CREATE DATABASE +
    // migrations on a cold container.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
