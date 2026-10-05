import { randomUUID } from 'node:crypto';
import { scrub } from './scrub';

/**
 * Sends server errors to Sentry when a DSN is set (ADR 0025). It speaks
 * Sentry's envelope API over `fetch` rather than pulling in the SDK, sends
 * only the error's type, message and stack (scrubbed), plus a few tags, and
 * never throws: reporting must not break the request or loop it reports on.
 */
export interface ErrorReporter {
  readonly enabled: boolean;
  capture(error: unknown, context?: { tags?: Record<string, string>; message?: string }): void;
  /** Resolves when every report started so far has finished, for shutdown and tests. */
  flush(): Promise<void>;
}

export interface Dsn {
  key: string;
  envelopeUrl: string;
}

export function parseDsn(dsn: string): Dsn {
  const url = new URL(dsn);
  const projectId = url.pathname.split('/').filter(Boolean).pop();
  if (!url.username || !projectId || !/^\d+$/.test(projectId)) {
    throw new Error('SENTRY_DSN is not a Sentry DSN');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('SENTRY_DSN must use https');
  }
  const prefix = url.pathname.slice(0, url.pathname.lastIndexOf(`/${projectId}`));
  return {
    key: url.username,
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
  };
}

interface Frame {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

/** V8 stack lines to Sentry frames, oldest call first. */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split('\n').slice(1, 51)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const [, fn, file = '', lineNo, col] = m;
    const filename = scrub(file);
    frames.push({
      ...(fn ? { function: fn } : {}),
      filename,
      lineno: Number(lineNo),
      colno: Number(col),
      in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    });
  }
  return frames.reverse();
}

export interface ReporterOptions {
  dsn?: string | undefined;
  service: 'web' | 'worker';
  environment?: string | undefined;
  release?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  /** At most this many reports a minute; the same error is sent once a minute. */
  perMinute?: number;
}

const DISABLED: ErrorReporter = {
  enabled: false,
  capture: () => undefined,
  flush: () => Promise.resolve(),
};

export function createErrorReporter(options: ReporterOptions): ErrorReporter {
  if (!options.dsn) return DISABLED;
  const dsn = parseDsn(options.dsn);
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const perMinute = options.perMinute ?? 30;
  const pending = new Set<Promise<void>>();
  const recent = new Map<string, number>();
  let windowStart = 0;
  let sentInWindow = 0;

  return {
    enabled: true,
    capture(error, context = {}) {
      try {
        const e =
          error instanceof Error
            ? error
            : new Error(typeof error === 'string' ? error : 'Non-error thrown');
        const type = e.name || 'Error';
        const value = scrub(context.message ? `${context.message}: ${e.message}` : e.message);
        const frames = parseStack(e.stack);
        const t = now();
        const fingerprint = `${type}|${value}|${frames.at(-1)?.filename}:${frames.at(-1)?.lineno}`;
        const last = recent.get(fingerprint);
        if (last !== undefined && t - last < 60_000) return;
        if (t - windowStart >= 60_000) {
          windowStart = t;
          sentInWindow = 0;
        }
        if (sentInWindow >= perMinute) return;
        sentInWindow += 1;
        recent.set(fingerprint, t);
        if (recent.size > 500) recent.clear();

        const eventId = randomUUID().replaceAll('-', '');
        const event = {
          event_id: eventId,
          timestamp: t / 1000,
          platform: 'node',
          level: 'error',
          logger: options.service,
          environment: options.environment ?? 'development',
          ...(options.release ? { release: options.release } : {}),
          tags: { service: options.service, ...context.tags },
          exception: {
            values: [{ type, value, ...(frames.length ? { stacktrace: { frames } } : {}) }],
          },
        };
        const body = [
          JSON.stringify({ event_id: eventId, sent_at: new Date(t).toISOString() }),
          JSON.stringify({ type: 'event' }),
          JSON.stringify(event),
        ].join('\n');
        const p = send(dsn.envelopeUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-sentry-envelope',
            'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=tm-observability/1.0`,
          },
          body,
          signal: AbortSignal.timeout(5000),
        })
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => pending.delete(p));
        pending.add(p);
      } catch {
        // Reporting is best effort.
      }
    },
    async flush() {
      await Promise.all([...pending]);
    },
  };
}
