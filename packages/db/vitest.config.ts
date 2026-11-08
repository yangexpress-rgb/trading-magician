import { defineConfig } from 'vitest/config';

// Integration test files each create a database, and test/harness.ts migrates
// them one at a time behind a lock, so a file's beforeAll can wait behind
// several others in CI. The default 10 s hook timeout is too short for that.
export default defineConfig({
  test: { hookTimeout: 60_000 },
});
