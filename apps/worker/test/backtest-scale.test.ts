import { MAX_BACKTEST_BARS } from '@tm/backtest';
import { claimBacktestRun, failRun, getBacktest, renewLease, withTenant } from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { processNextRun } from '../src/backtests';
import { createScenario, syntheticFeed } from './earnings-breakout-scenario';

/**
 * Regression tests for the abandoned Earnings breakout back tests (diagnosis
 * 2026-11-11, ADR 0081): a run too big for the worker is refused with its
 * reason instead of crashing the worker three times, a large group simulates
 * in seconds, and the simulation can't lose its lease to another worker.
 */

const YEAR = { from: '2025-11-08', to: '2026-11-07' };

interface Line {
  event?: string;
  stage?: string;
  ms?: number;
  leaseSeconds?: number;
}

function capture() {
  const lines: Line[] = [];
  const push = (obj: unknown) => {
    if (obj && typeof obj === 'object') lines.push(obj as Line);
  };
  return { lines, logger: { info: push, warn: push, error: push } };
}

let t: TestDatabase | undefined;

afterEach(async () => {
  await t?.drop();
  t = undefined;
});

describe('back test size and lease (ADR 0081)', () => {
  it('refuses an S&P 500-sized year of 5-minute bars before queuing it, with the reason', async () => {
    t = await createTestDatabase();
    const scenario = await createScenario(t, {
      members: 502,
      ...YEAR,
      price: '5m',
      earnings: true,
      ranking: true,
    });
    const started = await scenario.start();
    expect(started).toEqual({
      refused: expect.stringMatching(
        /^This back test needs about 10\.\d million price bars, mostly 5-minute bars for 502 instruments over about 12 months\. A back test can hold up to 1\.2 million\./,
      ),
    });
    expect(MAX_BACKTEST_BARS).toBe(1_200_000);
  }, 60_000);

  it('fails a queued run that is too big before loading any bar, naming the reason', async () => {
    t = await createTestDatabase();
    const scenario = await createScenario(t, {
      members: 5,
      ...YEAR,
      price: '5m',
      earnings: true,
      ranking: true,
    });
    const started = await scenario.start();
    if (!('runId' in started)) throw new Error(started.refused);
    const feed = syntheticFeed();
    const { lines, logger } = capture();
    const outcome = await processNextRun({
      db: t.app.db,
      provider: feed.provider,
      workerId: 'w1',
      logger,
      heartbeatMs: 0,
      // Five members' year of 5-minute bars is about 100,000: over this test limit.
      maxBars: 50_000,
      resolveUniverse: async () => ({ ids: scenario.ids, warnings: [] }),
    });
    expect(outcome).toBe('failed');
    expect(feed.calls.count).toBe(0);
    const run = await scenario.asUser((tx) => getBacktest(tx, started.runId));
    expect(run.error).toMatch(
      /^This back test needs about 1\d\d,\d{3} price bars, mostly 5-minute/,
    );
    expect(lines.some((l) => l.stage === 'load_bars')).toBe(false);
  }, 60_000);

  it('simulates 150 members over a year of daily bars in seconds, on a lease it keeps', async () => {
    t = await createTestDatabase();
    const scenario = await createScenario(t, {
      members: 150,
      ...YEAR,
      price: '1d',
      earnings: true,
      ranking: true,
    });
    const started = await scenario.start();
    if (!('runId' in started)) throw new Error(started.refused);
    const { lines, logger } = capture();
    const outcome = await processNextRun({
      db: t.app.db,
      provider: syntheticFeed().provider,
      workerId: 'w1',
      logger,
      heartbeatMs: 0,
      resolveUniverse: async () => ({ ids: scenario.ids, warnings: [] }),
    });
    expect(outcome).toBe('completed');
    const stage = (name: string) =>
      lines.find((l) => l.event === 'backtest.stage' && l.stage === name);
    // members x series made this about 30 s before the fix; now it is about 1 s.
    expect(stage('simulate')?.ms).toBeLessThan(10_000);
    // The simulation can't renew while it runs, so it starts on a 10-minute lease.
    expect(stage('renew_before_simulate')?.leaseSeconds).toBe(600);
  }, 120_000);

  it('lets no second worker claim a run under the simulation lease, and refuses a worker that lost it', async () => {
    t = await createTestDatabase();
    const scenario = await createScenario(t, {
      members: 3,
      from: '2026-10-01',
      to: '2026-11-06',
      price: '1d',
      earnings: false,
      ranking: false,
    });
    const started = await scenario.start();
    if (!('runId' in started)) throw new Error(started.refused);
    const db = t.app.db;
    const claimed = await claimBacktestRun(db, 'w1', { leaseSeconds: 5, maxAttempts: 3 });
    expect(claimed?.runId).toBe(started.runId);
    const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
      withTenant(db, { userId: scenario.userId }, fn);

    // Under the simulation lease another worker gets nothing.
    await inTenant((tx) => renewLease(tx, started.runId, 'w1', 600));
    await new Promise((r) => setTimeout(r, 1_200));
    expect(await claimBacktestRun(db, 'w2', { leaseSeconds: 120, maxAttempts: 3 })).toBeNull();

    // Once a lease has lapsed and another worker claimed the run, the first can't write to it.
    await inTenant((tx) => renewLease(tx, started.runId, 'w1', 1));
    await new Promise((r) => setTimeout(r, 1_200));
    const second = await claimBacktestRun(db, 'w2', { leaseSeconds: 120, maxAttempts: 3 });
    expect(second?.runId).toBe(started.runId);
    expect(await inTenant((tx) => renewLease(tx, started.runId, 'w1', 120))).toBeNull();
    expect(await inTenant((tx) => failRun(tx, started.runId, 'w1', 'late'))).toBe(false);
  }, 30_000);
});
