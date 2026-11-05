import 'server-only';
import {
  createErrorReporter,
  createLogger,
  type ErrorReporter,
  type Logger,
} from '@tm/observability';
import { serverEnv } from './env';

/**
 * The web app's JSON logger and error reporter (ADR 0025). Errors logged with
 * `{ err }` also go to Sentry when SENTRY_DSN is set.
 */
const globalForLog = globalThis as unknown as { tmLogger?: Logger; tmReporter?: ErrorReporter };

export function reporter(): ErrorReporter {
  if (!globalForLog.tmReporter) {
    const env = serverEnv();
    globalForLog.tmReporter = createErrorReporter({
      dsn: env.SENTRY_DSN,
      service: 'web',
      environment: env.SENTRY_ENVIRONMENT ?? env.RAILWAY_ENVIRONMENT_NAME ?? env.NODE_ENV,
      release: env.RAILWAY_GIT_COMMIT_SHA,
    });
  }
  return globalForLog.tmReporter;
}

export function logger(): Logger {
  return (globalForLog.tmLogger ??= createLogger(serverEnv().LOG_LEVEL, {
    reporter: reporter(),
    base: { service: 'web' },
  }));
}
