import { DEFAULT_BACKTEST_INPUTS, ENGINE_VERSION, type BacktestResult } from '@tm/backtest';
import { createDefinition } from '@tm/domain';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimBacktestRun, completeRun, listBacktestTrades, startBacktest } from '../src/backtests';
import type { Transaction } from '../src/client';
import { provisionWorkspace } from '../src/provision';
import {
  researchStore,
  researchTx,
  RESEARCH_TABLES,
  ResearchUnavailableError,
  researchUnavailable,
} from '../src/research';
import { clearCoreCopies, moveResearchTables, verified } from '../src/research-move';
import { instruments, tradingAccounts, users } from '../src/schema';
import {
  expireAuditEvents,
  expireNotifications,
  researchTablesInCore,
  storageBytes,
  sweepResearchStore,
  thinPositionSnapshots,
} from '../src/storage';
import { createStrategy } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * The Research Store as its own database (ADR 0115, N331–N333): back test
 * trades are written and read there, the move copies Core's research rows and
 * proves it, the sweep and retention trims, and its tenant isolation.
 */

let t: TestDatabase;
let userA: string;
let userB: string;
let demoA: string;
let accountA: string;

const asA = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId: userA }, fn);
const research = () => researchStore(t.app.db, t.research!.app.db);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  return row!.id;
}

function result(): BacktestResult {
  return {
    engineVersion: ENGINE_VERSION,
    dataVersions: ['demo-history@1'],
    assumptions: [],
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

/** A definition that validates: buy and sell DEMO-A on its daily close. */
function readyDefinition() {
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

/** The database's own message behind a driver error. */
const reason = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (e: unknown) => {
      const err = e as { message?: string; cause?: { message?: string } };
      return `${err.message ?? ''} ${err.cause?.message ?? ''}`;
    },
  );

async function completedRun(): Promise<string> {
  const def = readyDefinition();
  const s = await asA((tx) => createStrategy(tx, userA, { name: 'R', definition: def }));
  const run = await asA((tx) =>
    startBacktest(tx, userA, s.id, {
      ...DEFAULT_BACKTEST_INPUTS,
      from: '2024-01-02',
      to: '2024-03-28',
    }),
  );
  await claimBacktestRun(t.app.db, 'w1', { leaseSeconds: 30, maxAttempts: 2 });
  const status = await asA((tx) =>
    completeRun(tx, userA, run.id, 'w1', result(), researchTx(research(), { userId: userA })),
  );
  expect(status).toBe('completed');
  return run.id;
}

beforeAll(async () => {
  t = await createTestDatabase({ research: true });
  userA = await createUser('ra@example.test');
  userB = await createUser('rb@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  demoA = (await t.owner.db.select().from(instruments)).find((r) => r.symbol === 'DEMO-A')!.id;
  accountA = (await asA((tx) => tx.select().from(tradingAccounts)))[0]!.id;
}, 90_000);

afterAll(async () => {
  await t?.drop();
});

describe('back test trades in the Research Store', () => {
  it('stores them in Research only, and reads them back through Core’s ownership check', async () => {
    const runId = await completedRun();
    const core =
      await t.ownerSql`select count(*)::int as n from backtest_trade where run_id = ${runId}`;
    expect(core[0]?.n).toBe(0);
    const res = await t.research!
      .ownerSql`select count(*)::int as n from backtest_trade where run_id = ${runId}`;
    expect(res[0]?.n).toBe(1);
    const trades = await asA((tx) =>
      listBacktestTrades(tx, runId, researchTx(research(), { userId: userA })),
    );
    expect(trades).toMatchObject([{ cycle: 1, netPnl: '10' }]);
    // Another tenant sees nothing, in either store.
    const asB = researchTx(research(), { userId: userB });
    expect(await asB((rtx) => rtx.execute(sql`select * from backtest_trade`))).toHaveLength(0);
  });

  it('replaces a run’s trades when the run is saved again (a retried attempt)', async () => {
    const runId = await completedRun();
    const store = researchTx(research(), { userId: userA });
    // A second save of the same trades (a retried attempt) leaves one copy.
    await t.ownerSql`update backtest_run set status = 'running', finished_at = null, lease_owner = 'w1',
      lease_expires_at = now() + interval '1 minute' where id = ${runId}`;
    expect(await asA((tx) => completeRun(tx, userA, runId, 'w1', result(), store))).toBe(
      'completed',
    );
    const res = await t.research!
      .ownerSql`select count(*)::int as n from backtest_trade where run_id = ${runId}`;
    expect(res[0]?.n).toBe(1);
  });
});

describe('moving Core’s research rows', () => {
  it('copies every table, proves it with a second pass, and only then clears Core', async () => {
    // Research rows written to Core before the switch.
    const [scan] = await t.ownerSql<{ id: string }[]>`
      insert into pattern_scan (user_id, config, summary) values (${userA}, '{}', 'old scan') returning id`;
    await t.ownerSql`insert into factor_snapshot (instrument_id, as_of, catalogue_version, "values", close_ret)
      values (${demoA}, '2024-01-02', 1, '{"x": 1}', 0.01), (${demoA}, '2024-01-03', 1, '{"x": 2}', 0.02)`;
    await t.ownerSql`insert into backtest_trade (user_id, run_id, cycle, status, gross_pnl, costs, net_pnl, return_pct, legs)
      select ${userA}, id, 9, 'closed', 1, 0, 1, 1, '[]' from backtest_run limit 1`;
    const core = t.ownerSql;
    const res = t.research!.ownerSql;

    const first = await moveResearchTables(core, res);
    expect(first.map((m) => m.table)).toEqual([...RESEARCH_TABLES]);
    const fs = first.find((m) => m.table === 'factor_snapshot')!;
    expect(fs).toMatchObject({ coreRows: 2, inserted: 2, researchAfter: 2, skipped: 0 });
    expect(first.find((m) => m.table === 'pattern_scan')!.inserted).toBe(1);
    // Not verified: the first pass copied rows.
    expect(verified(first)).toBe(false);
    await expect(clearCoreCopies(core, first)).rejects.toThrow(/Refused/);

    const second = await moveResearchTables(core, res);
    expect(second.every((m) => m.inserted === 0)).toBe(true);
    expect(verified(second)).toBe(true);
    expect(await researchTablesInCore(t.worker.db)).toEqual(
      expect.arrayContaining(['factor_snapshot', 'pattern_scan', 'backtest_trade']),
    );
    await clearCoreCopies(core, second);
    expect(await researchTablesInCore(t.worker.db)).toEqual([]);
    const moved = await res<{ id: string }[]>`select id from pattern_scan where id = ${scan!.id}`;
    expect(moved).toHaveLength(1);
  }, 60_000);
});

describe('integrity sweep and retention trims', () => {
  it('drops Research rows whose account or back test run is gone from Core', async () => {
    const ghost = '00000000-0000-4000-8000-000000000001';
    const ghostRun = '00000000-0000-4000-8000-000000000002';
    await t.research!
      .ownerSql`insert into pattern_scan (user_id, config, summary) values (${ghost}, '{}', 'ghost')`;
    await t.research!
      .ownerSql`insert into backtest_trade (user_id, run_id, cycle, status, gross_pnl, costs, net_pnl, return_pct, legs)
      values (${userA}, ${ghostRun}, 1, 'closed', 1, 0, 1, 1, '[]')`;
    const swept = await sweepResearchStore(
      t.worker.db,
      researchStore(t.worker.db, t.research!.worker.db),
    );
    expect(swept.purgedUserRows).toBe(1);
    expect(swept.orphanTrades).toBe(1);
    const left = await t.research!
      .ownerSql`select count(*)::int as n from pattern_scan where user_id = ${ghost}`;
    expect(left[0]?.n).toBe(0);
  });

  it('expires notifications, keeps audit events a year, and thins old position snapshots', async () => {
    await t.ownerSql`insert into notification (user_id, kind, title, body, created_at)
      values (${userA}, 'billing', 'old', '', now() - interval '200 days'),
             (${userA}, 'billing', 'new', '', now())`;
    expect(await expireNotifications(t.worker.db, 180)).toBe(1);
    expect(await reason(expireNotifications(t.worker.db, 7))).toMatch(/at least 30 days/);

    // The audit log stays append-only; only the expiry function removes rows past a year.
    await t.ownerSql`alter table audit_event disable trigger audit_event_no_update_delete`;
    await t.ownerSql`insert into audit_event (user_id, actor_type, action, resource_type, occurred_at)
      values (${userA}, 'user', 'test.old', 'test', now() - interval '400 days')`;
    await t.ownerSql`alter table audit_event enable trigger audit_event_no_update_delete`;
    expect(await reason(t.ownerSql`delete from audit_event where action = 'test.old'`)).toMatch(
      /append-only/,
    );
    expect(await reason(expireAuditEvents(t.worker.db, 30))).toMatch(/at least 365 days/);
    expect(await expireAuditEvents(t.worker.db, 365)).toBe(1);

    // Three snapshots on one old day keep the day's last; recent ones all stay.
    for (const [at, qty] of [
      ['2026-01-05T15:00:00Z', 1],
      ['2026-01-05T18:00:00Z', 2],
      ['2026-01-05T20:30:00Z', 3],
    ] as const)
      await t.ownerSql`insert into position_snapshot (user_id, account_id, instrument_id, quantity, source, as_of)
        values (${userA}, ${accountA}, ${demoA}, ${qty}, 'app', ${at})`;
    await t.ownerSql`insert into position_snapshot (user_id, account_id, instrument_id, quantity, source, as_of)
      values (${userA}, ${accountA}, ${demoA}, 5, 'app', now()), (${userA}, ${accountA}, ${demoA}, 6, 'app', now())`;
    expect(await thinPositionSnapshots(t.worker.db, 30)).toBe(2);
    const kept = await t.ownerSql<{ quantity: string }[]>`
      select quantity::text from position_snapshot where account_id = ${accountA} order by as_of`;
    expect(kept.map((r) => Number(r.quantity))).toEqual([3, 5, 6]);
  });

  it('reads each database’s size for the storage alert', async () => {
    expect(await storageBytes(t.worker.db)).toBeGreaterThan(1_000_000);
    expect(await storageBytes(t.research!.worker.db)).toBeGreaterThan(1_000_000);
  });
});

describe('when the Research Store is down', () => {
  it('reports it as unavailable, not as a crash', async () => {
    const dead = postgres('postgres://nobody:x@127.0.0.1:1/none', {
      max: 1,
      connect_timeout: 2,
      onnotice: () => undefined,
    });
    const error = await dead`select 1`.catch((e: unknown) => e);
    await dead.end();
    expect(researchUnavailable(error)).toBeInstanceOf(ResearchUnavailableError);
    expect((researchUnavailable(error) as Error).message).toMatch(/Trading is unaffected/);
  });
});
