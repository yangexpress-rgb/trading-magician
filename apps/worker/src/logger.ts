import { pino } from 'pino';

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
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
];

export function createLogger(level: string, destination?: pino.DestinationStream) {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, destination);
}
