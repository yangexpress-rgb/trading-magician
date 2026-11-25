import { defineConfig } from 'vitest/config';

// Integration test files each create a database, and @tm/db's test harness
// migrates them one at a time behind a lock, so a file's beforeAll can wait
// behind several others in CI (the same reason as packages/db's config). The
// default 10 s hook timeout is too short for that.
export default defineConfig({
  test: { hookTimeout: 60_000 },
});
