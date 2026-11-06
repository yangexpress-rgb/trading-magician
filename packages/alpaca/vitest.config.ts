import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The fake Alpaca builds demo history on first use. That takes well under a
    // second alone, but past 5 s on CI while every package's tests run at once.
    testTimeout: 30_000,
  },
});
