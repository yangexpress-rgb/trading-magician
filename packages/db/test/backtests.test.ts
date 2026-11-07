import { DEFAULT_BACKTEST_INPUTS, ENGINE_VERSION, type BacktestResult } from '@tm/backtest';
import { createDefinition, type StrategyDefinition } from '@tm/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelBacktest,
  claimBacktestRun,
  completeRun,
  failRun,
  getBacktest,
  latestCompletedBacktest,
  listBacktests,
  listBacktestTrades,
  loadRunWork,
  renewLease,
  startBacktest,
} from '../src/backtests';
import type { Transaction } from '../src/client';
import { provisionWorkspace } from '../src/provision';
import {
  auditEvents,
  backtestRuns,
  entitlements,
  instruments,
  tradingAccounts,
  users,
} from '../src/schema';
import {
  createStrategy,
  getStrategy,
  listStrategies,
  startStrategy,
  StrategyError,
  updateStrategy,
  validateStoredStrategy,
} from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let userA: string;
let userB: string;
let demoA: string;
let accountA: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const asA = <T>(fn: (tx: Transaction) => Promise<T>) => as(userA, fn);
const inputs = { ...DEFAULT_BACKTEST_INPUTS, from: '2024-01-02', to: '2024-06-28' };
const QUEUE = { leaseSeconds: 30, maxAttempts: 2 };

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

async function expectStrategyError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(StrategyError);
  expect((error as StrategyError).code).toBe(code);
  return error as StrategyError;
}

function readyDefinition(): StrategyDefinition {
  const def = createDefinition();
  const px = {
    kind: 'market' as const,
    instrumentId: demoA,
    field: 'close' as const,
    interval: '1d' as const,
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
    offset: 0,
  };
  def.entry.condition.children = [
    {
      kind: 'comparison',
      id: 'entry',
      operator: 'gt',
      left: { ...px, id: 'p1' },
      right: { kind: 'constant', id: 'k1', value: '100' },
    },
  ];
  def.exit.condition.children = [
    {
      kind: 'comparison',
      id: 'exit',
      operator: 'lt',
      left: { ...px, id: 'p2' },
      right: { kind: 'constant', id: 'k2', value: '95' },
    },
  ];
  const leg = {
    instrumentId: demoA,
    accountId: accountA,
    quantity: { type: 'units' as const, value: '10', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    timing: { mode: 'immediate' as const },
  };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy A', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell A', side: 'sell', ...leg }];
  return def;
}

const newStrategy = (name = 'Tested') =>
  asA((tx) => createStrategy(tx, userA, { name, definition: readyDefinition() }));

function fakeResult(): BacktestResult {
  return {
    engineVersion: ENGINE_VERSION,
    dataVersions: ['demo-history@1'],
    assumptions: ['Results are estimates, not guarantees'],
    sharpeMethod: 'test',
    metrics: {
      initialCapital: '100000',
      finalEquity: '100010',
      netReturnPct: '0.01',
      grossReturnPct: '0.01',
      maxDrawdownPct: '0',
      winRatePct: '100',
      profitFactor: null,
      sharpe: null,
      cycles: 1,
      closedCycles: 1,
      orders: 2,
      fills: 2,
      commission: '0',
      slippage: '0',
      borrow: '0',
      averageExposurePct: '1',
    },
    equity: [],
    trades: [
      {
        cycle: 1,
        status: 'closed',
        entryTime: '2024-01-03T14:30:00.000Z',
        exitTime: '2024-01-05T14:30:00.000Z',
        legs: [],
        grossPnl: '10',
        costs: '0',
        netPnl: '10',
        returnPct: '1',
      },
    ],
    fills: [],
    contributions: [],
    warnings: [],
  };
}

/** Clears every run so each test starts with an empty queue. */
async function clearQueue() {
  await t.ownerSql`delete from backtest_run`;
}

/** Makes a running run's lease look expired. */
async function expireLease(runId: string) {
  await t.ownerSql`update backtest_run set lease_expires_at = now() - interval '1 second' where id = ${runId}`;
}

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('a@example.test');
  userB = await createUser('b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  const rows = await t.owner.db.select().from(instruments);
  demoA = rows.find((r) => r.symbol === 'DEMO-A')!.id;
  accountA = (await asA((tx) => tx.select().from(tradingAccounts)))[0]!.id;
  // Room for the queue tests to hold several runs at once.
  await t.owner.db
    .update(entitlements)
    .set({ overrides: { concurrentBacktests: 5, backtestRunsPerDay: 100 } })
    .where(eq(entitlements.userId, userA));
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

beforeEach(clearQueue);

describe('queuing a back test', () => {
  it('pins the draft as a version without disturbing the editor', async () => {
    const s = await newStrategy();
    const run = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    expect(run).toMatchObject({
      strategyId: s.id,
      versionNo: 1,
      definitionHash: s.definitionHash,
      status: 'queued',
      inputs,
      dataSource: 'demo-history',
      metrics: null,
      result: null,
    });
    const after = await asA((tx) => getStrategy(tx, s.id));
    expect(after.rowVersion).toBe(s.rowVersion);
    expect(after.currentVersion?.versionNo).toBe(1);
    expect(after.hasUnpublishedChanges).toBe(false);

    // The same rules reuse version 1; changed rules get version 2.
    const again = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    expect(again.versionNo).toBe(1);
    const def = readyDefinition();
    def.risk.maxOrderNotional = '5000';
    await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: after.rowVersion, definition: def }),
    );
    await clearQueue();
    expect((await asA((tx) => startBacktest(tx, userA, s.id, inputs))).versionNo).toBe(2);
  });

  it('refuses a strategy with validation errors', async () => {
    const s = await asA((tx) => createStrategy(tx, userA, { name: 'Empty' }));
    const e = await expectStrategyError(
      asA((tx) => startBacktest(tx, userA, s.id, inputs)),
      'transition_blocked',
    );
    expect(e.message).toMatch(/Validation/);
  });

  it('caps concurrent runs per user from the plan', async () => {
    const s = await newStrategy();
    await t.owner.db
      .update(entitlements)
      .set({ overrides: { concurrentBacktests: 2, backtestRunsPerDay: 100 } })
      .where(eq(entitlements.userId, userA));
    try {
      await asA((tx) => startBacktest(tx, userA, s.id, inputs));
      await asA((tx) => startBacktest(tx, userA, s.id, inputs));
      await expect(asA((tx) => startBacktest(tx, userA, s.id, inputs))).rejects.toMatchObject({
        code: 'plan_limit',
        details: { limit: 'concurrentBacktests', allowed: 2, used: 2 },
      });
    } finally {
      await t.owner.db
        .update(entitlements)
        .set({ overrides: { concurrentBacktests: 5, backtestRunsPerDay: 100 } })
        .where(eq(entitlements.userId, userA));
    }
  });

  it('cancels a queued run at once', async () => {
    const s = await newStrategy();
    const run = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    const canceled = await asA((tx) => cancelBacktest(tx, userA, run.id));
    expect(canceled.status).toBe('canceled');
    expect(canceled.finishedAt).not.toBeNull();
    expect(await claimBacktestRun(t.app.db, 'w1', QUEUE)).toBeNull();
    await expectStrategyError(
      asA((tx) => cancelBacktest(tx, userA, run.id)),
      'invalid_state',
    );
  });
});

describe('the queue', () => {
  it('hands each run to exactly one worker, oldest first', async () => {
    const s = await newStrategy();
    const first = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    const second = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    const claims = await Promise.all(
      ['w1', 'w2', 'w3'].map((w) => claimBacktestRun(t.app.db, w, QUEUE)),
    );
    const ids = claims.filter((c) => c !== null).map((c) => c.runId);
    expect(ids.sort()).toEqual([first.id, second.id].sort());
    expect(claims.filter((c) => c === null)).toHaveLength(1);
    expect(claims.find((c) => c)?.userId).toBe(userA);
    const run = await asA((tx) => getBacktest(tx, first.id));
    expect(run.status).toBe('running');
    expect(run.startedAt).not.toBeNull();
  });

  it('gives the worker the pinned rules and instruments, and stores the result', async () => {
    const s = await newStrategy();
    const run = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    const latest = async () =>
      (await asA((tx) => listStrategies(tx))).items.find((i) => i.id === s.id)?.latestBacktest;
    expect(await latest()).toMatchObject({ runId: run.id, status: 'queued', netReturnPct: null });
    const claim = await claimBacktestRun(t.app.db, 'w1', QUEUE);
    expect(claim?.runId).toBe(run.id);

    const work = await asA((tx) => loadRunWork(tx, run.id, 'w1'));
    expect(work?.inputs).toEqual(inputs);
    expect(work?.definition.entry.orders[0]?.id).toBe('buy');
    expect(work?.instruments.get(demoA)?.symbol).toBe('DEMO-A');
    expect(await asA((tx) => loadRunWork(tx, run.id, 'other'))).toBeNull();

    expect(await asA((tx) => renewLease(tx, run.id, 'w1', 30))).toEqual({ cancelRequested: false });
    expect(await asA((tx) => completeRun(tx, userA, run.id, 'w1', fakeResult()))).toBe('completed');

    const done = await asA((tx) => getBacktest(tx, run.id));
    expect(done).toMatchObject({
      status: 'completed',
      engineVersion: ENGINE_VERSION,
      dataVersions: ['demo-history@1'],
      metrics: { netReturnPct: '0.01', cycles: 1 },
      result: { assumptions: ['Results are estimates, not guarantees'] },
    });
    expect(done.result).not.toHaveProperty('trades');
    const trades = await asA((tx) => listBacktestTrades(tx, run.id));
    expect(trades).toMatchObject([{ cycle: 1, status: 'closed', netPnl: '10', returnPct: '1' }]);
    expect((await asA((tx) => latestCompletedBacktest(tx, s.id)))?.id).toBe(run.id);
    expect((await asA((tx) => listBacktests(tx, s.id))).map((r) => r.id)).toEqual([run.id]);
    // The Strategy Lab list shows the newest run's net return.
    expect(await latest()).toEqual({
      runId: run.id,
      status: 'completed',
      netReturnPct: '0.01',
      finishedAt: done.finishedAt,
    });
  });

  it('lets another worker take over a run whose lease lapsed, and shuts out the first', async () => {
    const s = await newStrategy();
    const run = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    await claimBacktestRun(t.app.db, 'crashed', QUEUE);
    expect(await claimBacktestRun(t.app.db, 'w2', QUEUE)).toBeNull();

    await expireLease(run.id);
    expect((await claimBacktestRun(t.app.db, 'w2', QUEUE))?.runId).toBe(run.id);
    // The crashed worker comes back: it can neither renew nor finish.
    expect(await asA((tx) => renewLease(tx, run.id, 'crashed', 30))).toBeNull();
    expect(await asA((tx) => completeRun(tx, userA, run.id, 'crashed', fakeResult()))).toBeNull();
    expect(await asA((tx) => failRun(tx, run.id, 'crashed', 'boom'))).toBe(false);
    expect(await asA((tx) => completeRun(tx, userA, run.id, 'w2', fakeResult()))).toBe('completed');
  });

  it('fails a run that keeps losing its worker', async () => {
    const s = await newStrategy();
    const run = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    for (let i = 0; i < QUEUE.maxAttempts; i++) {
      expect((await claimBacktestRun(t.app.db, `w${i}`, QUEUE))?.runId).toBe(run.id);
      await expireLease(run.id);
    }
    expect(await claimBacktestRun(t.app.db, 'last', QUEUE)).toBeNull();
    const failed = await asA((tx) => getBacktest(tx, run.id));
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/stopped responding/);
  });

  it('cancels a running run at the worker’s next checkpoint, or when its lease lapses', async () => {
    const s = await newStrategy();
    const run = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    await claimBacktestRun(t.app.db, 'w1', QUEUE);
    expect((await asA((tx) => cancelBacktest(tx, userA, run.id))).status).toBe('running');
    expect(await asA((tx) => renewLease(tx, run.id, 'w1', 30))).toEqual({ cancelRequested: true });
    // Finishing after a cancel request ends the run as canceled, without results.
    expect(await asA((tx) => completeRun(tx, userA, run.id, 'w1', fakeResult()))).toBe('canceled');
    expect(await asA((tx) => listBacktestTrades(tx, run.id))).toEqual([]);

    const orphan = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    await claimBacktestRun(t.app.db, 'crashed', QUEUE);
    await asA((tx) => cancelBacktest(tx, userA, orphan.id));
    await expireLease(orphan.id);
    expect(await claimBacktestRun(t.app.db, 'w2', QUEUE)).toBeNull();
    expect((await asA((tx) => getBacktest(tx, orphan.id))).status).toBe('canceled');
  });

  it('rejects out-of-range queue arguments', async () => {
    await expect(
      claimBacktestRun(t.app.db, 'w1', { leaseSeconds: 0, maxAttempts: 1 }),
    ).rejects.toThrow();
  });
});

describe('tenant isolation', () => {
  it('keeps runs and trades private to their owner', async () => {
    const s = await newStrategy();
    const run = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    await claimBacktestRun(t.app.db, 'w1', QUEUE);
    await asA((tx) => completeRun(tx, userA, run.id, 'w1', fakeResult()));

    await expectStrategyError(
      as(userB, (tx) => getBacktest(tx, run.id)),
      'not_found',
    );
    await expectStrategyError(
      as(userB, (tx) => listBacktestTrades(tx, run.id)),
      'not_found',
    );
    await expectStrategyError(
      as(userB, (tx) => cancelBacktest(tx, userB, run.id)),
      'not_found',
    );
    await expectStrategyError(
      as(userB, (tx) => startBacktest(tx, userB, s.id, inputs)),
      'not_found',
    );
    expect(await as(userB, (tx) => tx.select().from(backtestRuns))).toEqual([]);
    // No tenant set: nothing visible at all.
    expect(await t.appSql`select id from backtest_run`).toHaveLength(0);
    expect(await t.appSql`select id from backtest_trade`).toHaveLength(0);
  });

  it('does not let the app delete runs or write another tenant’s', async () => {
    const s = await newStrategy();
    const run = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    await expect(
      asA((tx) => tx.delete(backtestRuns).where(eq(backtestRuns.id, run.id))),
    ).rejects.toThrow();
    await expect(
      as(userB, (tx) =>
        tx.execute(
          sql`update backtest_run set status = 'completed', finished_at = now() where id = ${run.id}`,
        ),
      ),
    ).resolves.toHaveLength(0);
    expect((await asA((tx) => getBacktest(tx, run.id))).status).toBe('queued');
  });
});

describe('activation gate', () => {
  const warningCodes = async (id: string) =>
    (await asA((tx) => validateStoredStrategy(tx, id))).validation.warnings.map((w) => w.code);

  it('warns until a back test matches the draft, and records the one shown at Start', async () => {
    let s = await newStrategy('Gated');
    expect(await warningCodes(s.id)).toContain('no_backtest');

    const run = await asA((tx) => startBacktest(tx, userA, s.id, inputs));
    expect(await warningCodes(s.id)).toContain('no_backtest'); // queued is not tested
    await claimBacktestRun(t.app.db, 'w1', QUEUE);
    await asA((tx) => completeRun(tx, userA, run.id, 'w1', fakeResult()));
    const tested = await asA((tx) => validateStoredStrategy(tx, s.id));
    expect(tested.validation.warnings.map((w) => w.code)).not.toContain('no_backtest');
    expect(tested.validation.warnings.map((w) => w.code)).not.toContain('stale_backtest');
    expect(tested.backtest).toMatchObject({ runId: run.id, definitionHash: s.definitionHash });

    // Changing the rules makes the test stale.
    const def = readyDefinition();
    def.risk.maxOrderNotional = '4000';
    s = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, definition: def }),
    );
    expect(await warningCodes(s.id)).toContain('stale_backtest');
    s = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, status: 'under_testing' }),
    );
    await expectStrategyError(
      asA((tx) => startStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, confirmed: true })),
      'transition_blocked',
    );
    s = await asA((tx) =>
      startStrategy(tx, userA, s.id, {
        rowVersion: s.rowVersion,
        confirmed: true,
        acknowledgedWarnings: ['stale_backtest'],
      }),
    );
    expect(s.statusHistory[0]?.acknowledgedWarnings).toEqual(['stale_backtest']);
    const [audit] = await asA((tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'strategy.started')),
    );
    expect(audit?.context).toMatchObject({ latestBacktestId: run.id });
  });
});
