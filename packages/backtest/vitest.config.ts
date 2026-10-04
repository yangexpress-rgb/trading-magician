import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Property tests and year-long demo runs take a few seconds; CI runners in parallel take longer.
    testTimeout: 60_000,
  },
});
