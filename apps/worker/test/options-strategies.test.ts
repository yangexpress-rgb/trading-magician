import { DEFAULT_BACKTEST_INPUTS } from '@tm/backtest';
import {
  addSeedUnderlyings,
  createFeed,
  createStrategy,
  getBacktest,
  provisionWorkspace,
  registerInstrument,
  saveOptionSignal,
  schema,
  startBacktest,
  validateStoredStrategy,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  CONTEXT_INSTRUMENT_ID,
  createDefinition,
  OPTION_SIGNAL_FIELDS,
  regularSession,
  tradingDays,
  type Bar,
  type HistoricalDataProvider,
  type OptionSignalValues,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processNextRun } from '../src/backtests';

/**
 * Options metrics in strategies (options data brief v2 §5.3, §6): the
 * builder's condition validates against the options feed and universe (F5),
 * back tests read the signals point in time, log the signal date used, and
 * fail by name before the first signal (F4). Since Phase 2 an options metric
 * also ranks a Selection group and picks the best leg in fire mode.
 */

let t: TestDatabase;
let userId: string;
let spy: string;
let qqq: string;
let account: string;

const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** SPY's daily bars on every NYSE day: a gentle climb, so fills always have a price. */
const provider: HistoricalDataProvider = {
  id: 'test-history',
  intervals: ['1d'],
  async getBars(req) {
    const bars: Bar[] = tradingDays(req.from, req.to).flatMap((d, i) => {
      const s = regularSession(d);
      if (!s) return [];
      const v = new Decimal(500 + i * 0.1);
      return [{ start: s.open, end: s.close, open: v, high: v, low: v, close: v, volume: v }];
    });
    return { bars, dataVersion: 'test-history@1', warnings: [] };
  },
};

/** Signal days: August rebuilt, September recorded, with no signal 14–25 September. */
const FIRST = '2026-08-03';
const LAST = '2026-09-30';
const GAP = ['2026-09-14', '2026-09-25'] as const;
/** The 5-day expected move: 2.5% for five sessions, then 1.5% for five, and so on. */
const moveOn = (i: number) => (i % 10 < 5 ? 0.025 : 0.015);

function expectedMoveRule(): StrategyDefinition {
  const def = createDefinition();
  const move = (id: string) => ({
    kind: 'metric' as const,
    id,
    metric: 'options.expected_move_5d_pct',
    params: {},
    instrumentId: spy,
  });
  // "SPY expected move % > 2": metric values are fractions, so 2% is 0.02 (brief §6 units).
  def.entry.condition.children = [
    {
      kind: 'comparison',
      id: 'wide',
      operator: 'gt',
      left: move('m1'),
      right: { kind: 'constant', id: 'c1', value: '0.02' },
    },
  ];
  def.exit.condition.children = [
    {
      kind: 'comparison',
      id: 'calm',
      operator: 'lt',
      left: move('m2'),
      right: { kind: 'constant', id: 'c2', value: '0.02' },
    },
  ];
  const leg = {
    instrumentId: spy,
    accountId: account,
    quantity: { type: 'units' as const, value: '1', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    timing: { mode: 'immediate' as const },
  };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy SPY', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell SPY', side: 'close', ...leg }];
  return def;
}

beforeAll(async () => {
  t = await createTestDatabase();
  spy = await t.worker.db.transaction((tx) =>
    registerInstrument(tx, {
      assetClass: 'etf',
      symbol: 'SPY',
      venue: 'ARCA',
      displayName: 'SPDR S&P 500 ETF Trust',
      provider: 'alpaca',
      providerId: 'spy-test',
    }),
  );
  qqq = await t.worker.db.transaction((tx) =>
    registerInstrument(tx, {
      assetClass: 'etf',
      symbol: 'QQQ',
      venue: 'NASDAQ',
      displayName: 'Invesco QQQ Trust',
      provider: 'alpaca',
      providerId: 'qqq-test',
    }),
  );
  await addSeedUnderlyings(t.worker.db, [spy, qqq]);
  const nulls = Object.fromEntries(
    OPTION_SIGNAL_FIELDS.map((f) => [f, null]),
  ) as OptionSignalValues;
  const days = tradingDays(FIRST, LAST);
  for (const [i, d] of days.entries()) {
    if (d >= GAP[0] && d <= GAP[1]) continue;
    await saveOptionSignal(t.worker.db, {
      underlyingId: spy,
      asOfDate: d,
      values: { ...nulls, expected_move_5d_pct: moveOn(i), iv30: moveOn(i) * Math.sqrt(365 / 5) },
      ivHistoryDays: 0,
      expiries: [],
      underlyingClose: 500,
      riskFreeRate: 0.04,
      dividendYield: 0,
      source: d < '2026-09-01' ? 'rebuilt' : 'recorded',
      feed: d < '2026-09-01' ? 'alpaca_bars' : 'cboe',
      computedAt: new Date(),
    });
    // QQQ: the same days, an expected move 1 point wider and IV30 to match.
    await saveOptionSignal(t.worker.db, {
      underlyingId: qqq,
      asOfDate: d,
      values: {
        ...nulls,
        expected_move_5d_pct: moveOn(i) + 0.01,
        iv30: (moveOn(i) + 0.01) * Math.sqrt(365 / 5),
      },
      ivHistoryDays: 0,
      expiries: [],
      underlyingClose: 400,
      riskFreeRate: 0.04,
      dividendYield: 0,
      source: d < '2026-09-01' ? 'rebuilt' : 'recorded',
      feed: d < '2026-09-01' ? 'alpaca_bars' : 'cboe',
      computedAt: new Date(),
    });
  }
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'o', email: 'options-strategies@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'O' });
  account = (await asUser((tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;
  // SPY is a real listing: let the paper account trade US listings (ADR 0018).
  await t.ownerSql`update trading_account
    set capabilities = jsonb_set(capabilities, '{coverage}', '"us"') where id = ${account}`;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.ownerSql`delete from backtest_run`;
});

const codes = (v: { validation: { errors: { code: string }[] } }) =>
  v.validation.errors.map((e) => e.code);

describe('an options condition in a strategy (F5)', () => {
  let strategyId: string;

  it('names the missing options feed, then validates once it is on', async () => {
    const s = await asUser((tx) =>
      createStrategy(tx, userId, { name: 'Wide moves', definition: expectedMoveRule() }),
    );
    strategyId = s.id;
    const before = await asUser((tx) => validateStoredStrategy(tx, s.id));
    expect(codes(before)).toContain('missing_options_feed');
    expect(
      before.validation.errors.find((e) => e.code === 'missing_options_feed')?.message,
    ).toMatch(/CBOE delayed options \(daily\)/);

    await asUser((tx) =>
      createFeed(tx, {
        userId,
        name: 'CBOE delayed options (daily)',
        provider: 'cboe_options',
        assetClasses: ['stock', 'etf'],
      }),
    );
    const after = await asUser((tx) => validateStoredStrategy(tx, s.id));
    expect(after.validation.errors).toEqual([]);
  });

  it('back tests over the recorded window, logging the signal date each bar read', async () => {
    const run = await asUser((tx) =>
      startBacktest(tx, userId, strategyId, {
        ...DEFAULT_BACKTEST_INPUTS,
        from: '2026-08-10',
        to: '2026-10-16',
      }),
    );
    expect(await processNextRun({ db: t.app.db, provider, workerId: 'w', logger: quiet })).toBe(
      'completed',
    );
    const done = await asUser((tx) => getBacktest(tx, run.id));
    expect(done.metrics?.cycles).toBeGreaterThan(0);
    const bars = done.result?.conditions?.entry.bars ?? [];
    const read = bars.flatMap((b) => b.checks.find((c) => c.id === 'wide')?.optionsAsOf ?? []);
    expect(read).toContain('2026-09-02');
    expect(read.some((d) => d.endsWith('(rebuilt)'))).toBe(true);

    // F4: the summary counts bars with and without options data.
    const coverage = done.result?.warnings.find((w) => w.code.startsWith('options_coverage'));
    expect(coverage?.message).toMatch(/^SPY: options data on \d+ of \d+ bars \(\d+ without\)/);
    expect(coverage?.message).toMatch(/approximate/);
  });

  it('reads a signal more than 5 trading days old as unknown (F4)', async () => {
    const run = await asUser((tx) =>
      startBacktest(tx, userId, strategyId, {
        ...DEFAULT_BACKTEST_INPUTS,
        from: '2026-09-21',
        to: '2026-09-25',
      }),
    );
    await processNextRun({ db: t.app.db, provider, workerId: 'w', logger: quiet });
    const done = await asUser((tx) => getBacktest(tx, run.id));
    // The last signal before the gap is 11 September; from 21 September it is more
    // than 5 trading days old, so the metric is unknown and the condition can't hold.
    const checks = (done.result?.conditions?.entry.bars ?? []).map((b) =>
      b.checks.find((c) => c.id === 'wide')!,
    );
    expect(checks.length).toBe(5);
    for (const c of checks) {
      expect(c.left).toBeNull();
      expect(c.truth).toBeNull();
      expect(c.optionsAsOf).toBeUndefined();
    }
  });

  it('fails by name when every date is before the first signal (F4)', async () => {
    const run = await asUser((tx) =>
      startBacktest(tx, userId, strategyId, {
        ...DEFAULT_BACKTEST_INPUTS,
        from: '2026-06-01',
        to: '2026-07-31',
      }),
    );
    expect(await processNextRun({ db: t.app.db, provider, workerId: 'w', logger: quiet })).toBe(
      'failed',
    );
    const done = await asUser((tx) => getBacktest(tx, run.id));
    expect(done.error).toBe(`No options data for SPY before ${FIRST}`);
  });

  it('ranks a Selection group by an options metric (brief §10 item 10)', async () => {
    const def = expectedMoveRule();
    def.entry.condition.children = [];
    def.exit.condition.children = [];
    def.trade = {
      kind: 'group',
      universe: { type: 'list', instrumentIds: [spy, qqq] },
      ranking: {
        metric: 'options.expected_move_5d_pct',
        params: {},
        direction: 'desc',
        count: { type: 'fixed', value: 1 },
      },
    };
    def.exit.rules = [...(def.exit.rules ?? []), { kind: 'leftGroup', id: 'left' }];
    const leg = def.entry.orders[0]!;
    def.entry.orders = [{ ...leg, legLabel: 'Buy each', instrumentId: CONTEXT_INSTRUMENT_ID }];
    def.exit.orders = [
      { ...def.exit.orders[0]!, legLabel: 'Close each', instrumentId: CONTEXT_INSTRUMENT_ID },
    ];
    const s = await asUser((tx) =>
      createStrategy(tx, userId, { name: 'Widest expected move', definition: def }),
    );
    const v = await asUser((tx) => validateStoredStrategy(tx, s.id));
    expect(v.validation.errors).toEqual([]);
    const run = await asUser((tx) =>
      startBacktest(tx, userId, s.id, {
        ...DEFAULT_BACKTEST_INPUTS,
        from: '2026-08-10',
        to: '2026-09-11',
      }),
    );
    expect(await processNextRun({ db: t.app.db, provider, workerId: 'w', logger: quiet })).toBe(
      'completed',
    );
    const done = await asUser((tx) => getBacktest(tx, run.id));
    const rounds = done.result?.selections?.rounds ?? [];
    expect(rounds.length).toBeGreaterThan(0);
    // QQQ's expected move is always 1 point wider than SPY's, so it ranks first.
    const ranked = rounds.find((r) => r.rows.every((row) => row[1] !== null))!;
    expect(ranked.rows.find((row) => row[0] === 'QQQ')?.[3]).toBe(1);
    expect(ranked.rows.find((row) => row[0] === 'SPY')?.[3]).toBe(2);
  });

  it('picks the best leg by an options metric in a Selection group of these legs', async () => {
    const def = expectedMoveRule();
    def.entry.condition.children = [];
    def.entry.rankedLegs = {
      metric: 'options.iv30',
      params: {},
      direction: 'desc',
      count: { type: 'fixed', value: 1 },
    };
    delete def.exit.trigger;
    const buy = def.entry.orders[0]!;
    def.entry.orders = [buy, { ...buy, id: 'buy-qqq', legLabel: 'Buy QQQ', instrumentId: qqq }];
    const sell = def.exit.orders[0]!;
    def.exit.orders = [sell, { ...sell, id: 'sell-qqq', legLabel: 'Sell QQQ', instrumentId: qqq }];
    const s = await asUser((tx) =>
      createStrategy(tx, userId, { name: 'Fire by IV30', definition: def }),
    );
    const v = await asUser((tx) => validateStoredStrategy(tx, s.id));
    expect(v.validation.errors).toEqual([]);
  });
});

describe('the expected-move exit (brief §10 item 10, ADR 0053)', () => {
  /** Buy SPY on a wide expected move (as above); exit only beyond 1% of the entry's move. */
  function moveExitStrategy(): StrategyDefinition {
    const def = expectedMoveRule();
    def.exit.condition.children = [];
    def.exit.rules = [
      { kind: 'expectedMove', id: 'em', horizon: 5, multiple: '0.01', side: 'either' },
    ];
    return def;
  }

  it('back tests, storing each exit with the band fixed at entry', async () => {
    const s = await asUser((tx) =>
      createStrategy(tx, userId, { name: 'Move exit', definition: moveExitStrategy() }),
    );
    // The options feed was added above.
    const v = await asUser((tx) => validateStoredStrategy(tx, s.id));
    expect(v.validation.errors).toEqual([]);
    const run = await asUser((tx) =>
      startBacktest(tx, userId, s.id, {
        ...DEFAULT_BACKTEST_INPUTS,
        from: '2026-08-10',
        to: '2026-09-11',
      }),
    );
    expect(await processNextRun({ db: t.app.db, provider, workerId: 'w', logger: quiet })).toBe(
      'completed',
    );
    const rows = await t.ownerSql<{ exit_reason: string | null; expected_move: unknown }[]>`
      select exit_reason, expected_move from backtest_trade where run_id = ${run.id} order by cycle`;
    const exited = rows.filter((r) => r.exit_reason === 'expected_move');
    expect(exited.length).toBeGreaterThan(0);
    const m = exited[0]!.expected_move as { movePct: string; lower: string; upper: string };
    expect([0.025, 0.015]).toContain(Number(m.movePct));
    expect(Number(m.upper)).toBeGreaterThan(Number(m.lower));
  });
});
