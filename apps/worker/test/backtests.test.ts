import { DEFAULT_BACKTEST_INPUTS } from '@tm/backtest';
import {
  createStrategy,
  getBacktest,
  listBacktestTrades,
  provisionWorkspace,
  schema,
  startBacktest,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { createDefinition, type HistoricalDataProvider, type StrategyDefinition } from '@tm/domain';
import { createDemoHistoryProvider } from '@tm/market-data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processNextRun, startBacktestLoop } from '../src/backtests';

let t: TestDatabase;
let userId: string;
let demoA: string;
let account: string;

const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const provider = createDemoHistoryProvider({ now: () => new Date('2026-10-02T21:00:00Z') });
const inputs = { ...DEFAULT_BACKTEST_INPUTS, from: '2023-01-03', to: '2023-12-29' };

/** Long DEMO-A while its close is above its 20-day average. */
function crossover(): StrategyDefinition {
  const def = createDefinition();
  const px = {
    instrumentId: demoA,
    field: 'close' as const,
    interval: '1d' as const,
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
    offset: 0,
  };
  const sma = { kind: 'indicator' as const, name: 'SMA', params: { period: 20 }, ...px };
  def.entry.condition.children = [
    {
      kind: 'comparison',
      id: 'in',
      operator: 'crosses_above',
      left: { kind: 'market', id: 'p1', ...px },
      right: { ...sma, id: 's1' },
    },
  ];
  def.exit.condition.children = [
    {
      kind: 'comparison',
      id: 'out',
      operator: 'crosses_below',
      left: { kind: 'market', id: 'p2', ...px },
      right: { ...sma, id: 's2' },
    },
  ];
  const leg = {
    instrumentId: demoA,
    accountId: account,
    quantity: { type: 'units' as const, value: '20', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    extendedHours: false,
    timing: { mode: 'immediate' as const },
    timingOnly: false,
  };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy A', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell A', side: 'close', ...leg }];
  return def;
}

async function queueRun() {
  const s = await asUser((tx) =>
    createStrategy(tx, userId, { name: 'Crossover', definition: crossover() }),
  );
  return asUser((tx) => startBacktest(tx, userId, s.id, inputs));
}

beforeAll(async () => {
  t = await createTestDatabase();
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'w', email: 'worker@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'W' });
  demoA = (await t.owner.db.select().from(schema.instruments)).find(
    (r) => r.symbol === 'DEMO-A',
  )!.id;
  account = (await asUser((tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.ownerSql`delete from backtest_run`;
});

describe('back-test worker', () => {
  it('runs a queued back test over demo history and stores the results', async () => {
    const run = await queueRun();
    const outcome = await processNextRun({ db: t.app.db, provider, workerId: 'w1', logger: quiet });
    expect(outcome).toBe('completed');

    const done = await asUser((tx) => getBacktest(tx, run.id));
    expect(done.status).toBe('completed');
    expect(done.engineVersion).toBe('engine@1');
    expect(done.dataVersions).toEqual(['demo-history@1+adjusted-2026-10-02']);
    expect(done.metrics?.cycles).toBeGreaterThan(0);
    expect(done.result?.equity.length).toBe(250);
    expect(done.result?.assumptions.join(' ')).toMatch(/estimates, not guarantees/);
    const trades = await asUser((tx) => listBacktestTrades(tx, run.id));
    expect(trades.length).toBe(done.metrics?.cycles);
    expect(trades[0]?.legs.map((l) => l.legId)).toEqual(['buy', 'sell']);

    expect(await processNextRun({ db: t.app.db, provider, workerId: 'w1', logger: quiet })).toBe(
      'idle',
    );
  });

  it('fails a run with a safe message when the data source breaks', async () => {
    const run = await queueRun();
    const broken: HistoricalDataProvider = {
      ...provider,
      getBars: () =>
        Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2')),
    };
    expect(
      await processNextRun({ db: t.app.db, provider: broken, workerId: 'w1', logger: quiet }),
    ).toBe('failed');
    const failed = await asUser((tx) => getBacktest(tx, run.id));
    expect(failed.error).toBe(
      'The back test could not be completed. Try again, or change the dates.',
    );
  });

  it('stops at the next checkpoint when the run is canceled', async () => {
    const run = await queueRun();
    const slow: HistoricalDataProvider = {
      ...provider,
      getBars: async (req) => {
        // The user cancels while the bars load.
        await t.ownerSql`update backtest_run set cancel_requested = true where id = ${run.id}`;
        return provider.getBars(req);
      },
    };
    expect(
      await processNextRun({ db: t.app.db, provider: slow, workerId: 'w1', logger: quiet }),
    ).toBe('canceled');
    expect(await asUser((tx) => listBacktestTrades(tx, run.id))).toEqual([]);
  });

  it('drains the queue in a loop and stops cleanly', async () => {
    const run = await queueRun();
    const loop = startBacktestLoop({
      db: t.app.db,
      provider,
      workerId: 'loop',
      logger: quiet,
      pollMs: 50,
    });
    try {
      for (let i = 0; i < 200; i++) {
        if ((await asUser((tx) => getBacktest(tx, run.id))).status === 'completed') break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await loop.stop();
    }
    expect((await asUser((tx) => getBacktest(tx, run.id))).status).toBe('completed');
  });
});
