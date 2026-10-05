import { pino } from 'pino';
import type { ErrorReporter } from './reporter';

/** Paths that must never reach logs (Design v1.0 §9.2, §16.1). */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'secretKey',
  '*.secretKey',
  'privateKey',
  '*.privateKey',
  'fields',
  '*.fields',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
];

export type Logger = pino.Logger;

const ERROR_LEVEL = 50;

/**
 * JSON lines on stdout, which Railway's log view searches by field. Error
 * logs carrying an error (`logger.error({ err }, '…')` or `logger.error(err)`)
 * also go to the error reporter.
 */
export function createLogger(
  level: string,
  options: { destination?: pino.DestinationStream; reporter?: ErrorReporter; base?: object } = {},
): Logger {
  const reporter = options.reporter;
  return pino(
    {
      level,
      ...(options.base !== undefined ? { base: options.base } : {}),
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      ...(reporter?.enabled
        ? {
            hooks: {
              logMethod(args, method, lvl) {
                if (lvl >= ERROR_LEVEL) {
                  const [first, second] = args as unknown[];
                  const err =
                    first instanceof Error
                      ? first
                      : first &&
                          typeof first === 'object' &&
                          (first as { err?: unknown }).err instanceof Error
                        ? (first as { err: Error }).err
                        : undefined;
                  if (err)
                    reporter.capture(err, typeof second === 'string' ? { message: second } : {});
                }
                return method.apply(this, args as Parameters<typeof method>);
              },
            },
          }
        : {}),
    },
    // Write synchronously to stdout: Next.js tears its logging down before the
    // process exits, and an async destination then reports a closed stream.
    options.destination ?? pino.destination({ fd: 1, sync: true }),
  );
}
