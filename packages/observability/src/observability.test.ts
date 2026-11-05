import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

interface SentEvent {
  level: string;
  exception: { values: { value: string; stacktrace: { frames: unknown[] } }[] };
}
import { createErrorReporter, createLogger, parseDsn, parseStack, scrub } from './index';

const DSN = 'https://publickey@o1.ingest.example.test/42';

function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{}');
  }) as unknown as typeof globalThis.fetch;
  const events = () =>
    calls.map((c) => JSON.parse(String(c.init.body).split('\n')[2]!) as SentEvent);
  return { calls, fetch, events };
}

describe('scrub', () => {
  it('removes keys, secrets, tokens, passwords and emails', () => {
    expect(
      scrub(
        'sk_test_abc123 whsec_xyz Bearer abc.def postgresql://tm_app:hunter2@db:5432/x ann@example.test',
      ),
    ).toBe(
      '[redacted key] [redacted secret] Bearer [redacted] postgresql://tm_app:[redacted]@db:5432/x [email]',
    );
  });
});

describe('error reporter', () => {
  it('is off without a DSN', () => {
    expect(createErrorReporter({ service: 'web' }).enabled).toBe(false);
  });

  it('refuses a malformed DSN', () => {
    expect(() => parseDsn('https://o1.example.test/42')).toThrow(/not a Sentry DSN/);
    expect(() => parseDsn('http://k@o1.example.test/42')).toThrow(/https/);
    expect(parseDsn(DSN).envelopeUrl).toBe('https://o1.ingest.example.test/api/42/envelope/');
  });

  it('sends a scrubbed event with tags, once a minute per error', async () => {
    let t = 1_000_000;
    const { calls, fetch, events } = capture();
    const reporter = createErrorReporter({
      dsn: DSN,
      service: 'worker',
      environment: 'staging',
      release: 'abc123',
      fetch,
      now: () => t,
    });
    const error = new Error('could not reach postgresql://u:pw@db/x for ann@example.test');
    reporter.capture(error, { tags: { loop: 'runtime' } });
    reporter.capture(error, { tags: { loop: 'runtime' } });
    await reporter.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://o1.ingest.example.test/api/42/envelope/');
    expect(new Headers(calls[0]!.init.headers).get('x-sentry-auth')).toContain(
      'sentry_key=publickey',
    );
    const [event] = events();
    expect(event).toMatchObject({
      level: 'error',
      environment: 'staging',
      release: 'abc123',
      tags: { service: 'worker', loop: 'runtime' },
    });
    expect(event!.exception.values[0]!.value).toBe(
      'could not reach postgresql://u:[redacted]@db/x for [email]',
    );
    expect(event!.exception.values[0]!.stacktrace.frames.length).toBeGreaterThan(0);
    t += 61_000;
    reporter.capture(error);
    await reporter.flush();
    expect(calls).toHaveLength(2);
  });

  it('caps reports a minute and never throws when sending fails', async () => {
    const reporter = createErrorReporter({
      dsn: DSN,
      service: 'web',
      perMinute: 2,
      fetch: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    });
    for (let i = 0; i < 5; i += 1) reporter.capture(new Error(`e${i}`));
    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  it('reads V8 stacks oldest call first', () => {
    const frames = parseStack(
      'Error: x\n    at inner (/app/a.ts:1:2)\n    at /app/node_modules/b.js:3:4\n    at node:internal/x:5:6',
    );
    expect(frames.map((f) => [f.function, f.filename, f.in_app])).toEqual([
      [undefined, 'node:internal/x', false],
      [undefined, '/app/node_modules/b.js', false],
      ['inner', '/app/a.ts', true],
    ]);
  });
});

describe('logger', () => {
  it('redacts secrets and reports error logs that carry an error', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const { calls, fetch, events } = capture();
    const reporter = createErrorReporter({ dsn: DSN, service: 'worker', fetch });
    const logger = createLogger('info', { destination, reporter });
    logger.info({ apiKey: 'AKXXXX', secretKey: 'shh' }, 'connected');
    logger.warn({ err: new Error('only a warning') }, 'warned');
    logger.error({ err: new Error('boom') }, 'loop failed');
    await reporter.flush();
    expect(lines[0]).not.toContain('AKXXXX');
    expect(lines[0]).not.toContain('shh');
    expect(calls).toHaveLength(1);
    expect(events()[0]!.exception.values[0]!.value).toBe('loop failed: boom');
  });
});
