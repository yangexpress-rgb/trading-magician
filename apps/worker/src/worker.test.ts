import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkerEnv, shiftedClock } from './env';
import { createHealthServer } from './health';
import { createLogger } from './logger';

describe('worker health endpoint', () => {
  const server = createHealthServer();
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('reports ok on /healthz and 404 elsewhere', async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'ok', service: 'worker', jobs: 'none' });
    expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
  });
});

describe('worker env', () => {
  it('applies defaults', () => {
    expect(loadWorkerEnv({})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      WORKER_HEALTH_PORT: 4001,
      BACKTEST_POLL_MS: 1000,
      RUNTIME_POLL_MS: 1000,
      FEED_CHECK_POLL_MS: 2000,
      VALUATION_EVERY_SEC: 300,
      BILLING_FAKE: false,
      ALPACA_FAKE: false,
    });
  });

  it('takes Stripe test-mode keys only, and the billing stand-in outside production only', () => {
    expect(loadWorkerEnv({ STRIPE_SECRET_KEY: 'sk_test_abc123' }).STRIPE_SECRET_KEY).toBe(
      'sk_test_abc123',
    );
    expect(() => loadWorkerEnv({ STRIPE_SECRET_KEY: 'sk_live_abc123' })).toThrow();
    expect(() => loadWorkerEnv({ NODE_ENV: 'production', BILLING_FAKE: 'true' })).toThrow(
      /tests only/,
    );
  });

  it('allows the fake Alpaca outside production only', () => {
    expect(loadWorkerEnv({ ALPACA_FAKE: 'true' }).ALPACA_FAKE).toBe(true);
    expect(() => loadWorkerEnv({ NODE_ENV: 'production', ALPACA_FAKE: 'true' })).toThrow(
      /tests only/,
    );
  });

  it('allows a shifted paper clock outside production only', () => {
    const start = '2026-10-06T14:31:00Z';
    expect(loadWorkerEnv({ PAPER_CLOCK_START: start }).PAPER_CLOCK_START).toBe(start);
    expect(() => loadWorkerEnv({ NODE_ENV: 'production', PAPER_CLOCK_START: start })).toThrow(
      /development and tests only/,
    );
    let real = 1_000_000;
    const clock = shiftedClock(start, () => real);
    expect(clock().toISOString()).toBe('2026-10-06T14:31:00.000Z');
    real += 90_000;
    expect(clock().toISOString()).toBe('2026-10-06T14:32:30.000Z');
  });
});

describe('worker logger', () => {
  it('redacts secret-looking fields', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    createLogger('info', sink).info(
      {
        credentials: { token: 'abc123', apiKey: 'k-999' },
        headers: { authorization: 'Bearer x' },
        opened: { fields: { keyId: 'PK1', secretKey: 's-777' } },
      },
      'connecting',
    );
    const out = lines.join('');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('k-999');
    expect(out).not.toContain('Bearer x');
    expect(out).not.toContain('s-777');
    expect(out).toContain('[redacted]');
  });
});
