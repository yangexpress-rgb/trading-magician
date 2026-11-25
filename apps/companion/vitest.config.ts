import { defineConfig } from 'vitest/config';

// The integration test starts a real local Postgres (initdb + start), which
// takes a few seconds on a cold CI runner.
export default defineConfig({
  test: { hookTimeout: 120_000, testTimeout: 60_000 },
});
