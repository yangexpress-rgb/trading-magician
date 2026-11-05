/**
 * Sends one deliberate test error to Sentry with the worker's own settings
 * (docs/deploy.md, Monitoring), and says whether Sentry accepted it:
 *
 *   railway run --service worker pnpm --filter @tm/worker sentry:test
 *
 * Exits non-zero when SENTRY_DSN is missing or Sentry refuses the report.
 */
import { createErrorReporter } from '@tm/observability';

const dsn = process.env.SENTRY_DSN;
if (!dsn) {
  process.stderr.write('SENTRY_DSN is not set, so nothing can be sent\n');
  process.exit(1);
}
const environment =
  process.env.SENTRY_ENVIRONMENT ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? 'development';
let status = 0;
const reporter = createErrorReporter({
  dsn,
  service: 'worker',
  environment,
  release: process.env.RAILWAY_GIT_COMMIT_SHA,
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    status = response.status;
    return response;
  },
});
const stamp = new Date().toISOString();
reporter.capture(new Error(`Deliberate Sentry test error (${environment}, ${stamp})`), {
  tags: { check: 'sentry-test' },
});
await reporter.flush();
if (status >= 200 && status < 300) {
  process.stdout.write(
    `Sentry accepted the test error (HTTP ${status}). Look for "Deliberate Sentry test error" ` +
      `in environment ${environment}.\n`,
  );
} else {
  process.stderr.write(`Sentry did not accept the test error (HTTP ${status || 'no answer'})\n`);
  process.exit(1);
}
