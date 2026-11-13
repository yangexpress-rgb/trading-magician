import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests run against a real database (TEST_DATABASE_URL), like the
// db package's: each file creates and migrates its own.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'], hookTimeout: 60_000, testTimeout: 30_000 },
});
