import { defineConfig } from 'vitest/config';

// PatchWork Core Backend — Vitest configuration
// Node environment (no browser/React needed — pure Express + SDK testing)
// Matches the vitest pattern used in cozy and sunshade-hub-ui.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'workers/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/routes/**/*.ts', 'workers/**/src/**/*.ts'],
      exclude: ['src/routes/**/*.test.ts', 'workers/**/src/**/*.test.ts', 'src/migrate.ts', 'src/teardown.ts'],
    },
  },
});
