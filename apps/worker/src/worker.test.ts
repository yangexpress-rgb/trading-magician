import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env';
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
    });
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
      { credentials: { token: 'abc123', apiKey: 'k-999' }, headers: { authorization: 'Bearer x' } },
      'connecting',
    );
    const out = lines.join('');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('k-999');
    expect(out).not.toContain('Bearer x');
    expect(out).toContain('[redacted]');
  });
});
