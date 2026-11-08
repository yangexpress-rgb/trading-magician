import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // tsconfig keeps JSX for Next ("preserve"); component tests need it compiled.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
  },
});
