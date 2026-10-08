import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Mirror the tsconfig `@/*` -> `./*` path alias so route handlers and libs that
// import via `@/lib/...` resolve under vitest the same way they do under Next.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // jsdom rendering under parallel workspace load routinely exceeds the
    // 5s default (observed recurring shadow-experiments timeouts); 10s is a
    // comfortable bound that still fails genuinely hung tests promptly.
    testTimeout: 10_000,
  },
});
