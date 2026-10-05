import { describe, expect, it } from 'vitest';
import { systemHealth, WORKER_STALE_SECONDS } from './system-health';

const now = new Date('2026-10-05T12:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe('system health', () => {
  it('is ok when the worker beat recently', () => {
    expect(systemHealth([{ service: 'worker', beatAt: ago(20) }], now)).toEqual({
      status: 'ok',
      database: 'ok',
      worker: 'ok',
      workerLastSeenSeconds: 20,
    });
  });

  it('is degraded when the worker is stale, never seen, or the database is down', () => {
    expect(
      systemHealth([{ service: 'worker', beatAt: ago(WORKER_STALE_SECONDS + 1) }], now),
    ).toMatchObject({ status: 'degraded', worker: 'stale' });
    expect(systemHealth([], now)).toMatchObject({ status: 'degraded', worker: 'never_seen' });
    expect(systemHealth(null, now)).toMatchObject({ status: 'degraded', database: 'unreachable' });
  });
});
