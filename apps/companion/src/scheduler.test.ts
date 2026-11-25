import { describe, expect, it } from 'vitest';
import { CompanionApiError } from './api';
import { runJobs, type Job } from './scheduler';

/** A fake clock: sleeping moves time forward; stops after `until` ms. */
function clock(until: number, controller: AbortController) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      if (t >= until) controller.abort();
    },
  };
}

describe('runJobs', () => {
  it('runs each job at start and then on its interval', async () => {
    const controller = new AbortController();
    const c = clock(60 * 60_000, controller);
    const runs: Record<string, number[]> = { hello: [], reference: [] };
    const jobs: Job[] = [
      { name: 'hello', everyMs: 15 * 60_000, run: async () => void runs.hello!.push(c.now()) },
      {
        name: 'reference',
        everyMs: 24 * 3_600_000,
        run: async () => void runs.reference!.push(c.now()),
      },
    ];
    const reason = await runJobs(jobs, controller.signal, {
      now: c.now,
      sleep: c.sleep,
      tickMs: 60_000,
    });
    expect(reason).toEqual({ kind: 'aborted' });
    expect(runs.hello).toEqual([0, 15 * 60_000, 30 * 60_000, 45 * 60_000]);
    expect(runs.reference).toEqual([0]);
  });

  it('tries a failed job again sooner, honouring Retry-After', async () => {
    const controller = new AbortController();
    const c = clock(10 * 60_000, controller);
    const at: number[] = [];
    let n = 0;
    const jobs: Job[] = [
      {
        name: 'reference',
        everyMs: 24 * 3_600_000,
        run: async () => {
          at.push(c.now());
          n += 1;
          if (n === 1) throw new CompanionApiError(429, 'rate_limited', 'slow down', 30);
          if (n === 2) throw new CompanionApiError(0, 'offline', 'no network');
          return undefined;
        },
      },
    ];
    const results: string[] = [];
    await runJobs(jobs, controller.signal, {
      now: c.now,
      sleep: c.sleep,
      retryMs: 2 * 60_000,
      onResult: async (_job, outcome) => void results.push(outcome.ok ? 'ok' : outcome.error),
    });
    expect(at).toEqual([0, 30_000, 150_000]);
    expect(results).toEqual(['slow down', 'no network', 'ok']);
  });

  it('stops when the pairing is gone', async () => {
    const controller = new AbortController();
    const c = clock(60 * 60_000, controller);
    const jobs: Job[] = [
      {
        name: 'hello',
        everyMs: 15 * 60_000,
        run: async () => {
          throw new CompanionApiError(401, 'connection_revoked', 'This companion was unpaired.');
        },
      },
    ];
    expect(await runJobs(jobs, controller.signal, { now: c.now, sleep: c.sleep })).toEqual({
      kind: 'unpaired',
      message: 'This companion was unpaired.',
    });
  });
});
