import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The demo feed builds its history on first use (as in packages/alpaca). That
    // takes well under a second alone, but past 5 s on CI while every package's
    // tests run at once.
    testTimeout: 30_000,
  },
});
