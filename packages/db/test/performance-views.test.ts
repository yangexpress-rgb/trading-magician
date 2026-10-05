import { buildLedger, createDefinition, type LedgerFill, type Mark } from '@tm/domain';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import {
  performanceSummary,
  performanceTimeseries,
  performanceTrades,
} from '../src/performance-views';
import { provisionWorkspace } from '../src/provision';
import { instruments, strategyRuntimes, tradingAccounts, users } from '../src/schema';
import { createStrategy, pinDraftVersion } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { loadAccountToValue, recordValuation } from '../src/valuations';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Performance views over stored valuations (ADR 0021). Two strategies on the
 * demo account, valued over three sessions:
 * - S1 buys 10 DEMO-A at 100 (marked 110, then 90) and sells at 120: +200.
 * - S2 buys 5 DEMO-IDX (an ETF) at 200 on day 2 (marked 210, then 190): -50.
 * Account P&L 100, -50, 150; equity from the $100,000 start 100,100, 99,950, 100,150.
 */

let t: TestDatabase;
let userA: string;
let userB: string;
let account: string;
let s1: { strategyId: string; runtimeId: string };
let s2: { strategyId: string; runtimeId: string };
let demoA: string;
let demoB: string;
let idx: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const asA = <T>(fn: (tx: Transaction) => Promise<T>) => as(userA, fn);
const d = (v: number) => new Decimal(v);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  return row!.id;
}

async function strategy(name: string) {
  return asA(async (tx) => {
    const s = await createStrategy(tx, userA, { name, definition: createDefinition() });
    const { versionId } = await pinDraftVersion(tx, userA, s.id);
    const [runtime] = await tx
      .insert(strategyRuntimes)
      .values({ userId: userA, strategyId: s.id, versionId, startedBy: userA })
      .returning();
    return { strategyId: s.id, runtimeId: runtime!.id };
  });
}

let n = 0;
const fill = (
  runtimeId: string,
  instrumentId: string,
  direction: 'buy' | 'sell',
  quantity: number,
  price: number,
  day: number,
): LedgerFill => ({
  id: `p${++n}`,
  runtimeId,
  accountId: account,
  instrumentId,
  cycleId: `cycle-${runtimeId}`,
  legLabel: 'Leg',
  direction,
  quantity: d(quantity),
  price: d(price),
  fee: d(0),
  multiplier: d(1),
  filledAt: new Date(Date.UTC(2026, 9, 4 + day, 15)),
});
const marks = (entries: [string, number][]) =>
  new Map<string, Mark>(
    entries.map(([id, price]) => [id, { price: d(price), at: new Date(), stale: false }]),
  );

async function close(
  day: number,
  fills: LedgerFill[],
  m: Map<string, Mark>,
  broker: [string, number][],
) {
  const date = `2026-10-0${4 + day}`;
  await asA(async (tx) =>
    recordValuation(tx, {
      userId: userA,
      account: (await loadAccountToValue(tx, account, date))!,
      session: { date, final: true },
      now: new Date(`${date}T20:05:00Z`),
      ledger: buildLedger(fills),
      marks: m,
      broker: { positions: new Map(broker.map(([id, q]) => [id, d(q)])) },
    }),
  );
}

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('perf-a@example.test');
  userB = await createUser('perf-b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  const rows = await t.owner.db.select().from(instruments);
  const bySymbol = (s: string) => rows.find((r) => r.symbol === s)!.id;
  demoA = bySymbol('DEMO-A');
  demoB = bySymbol('DEMO-B');
  idx = bySymbol('DEMO-IDX');
  account = (await asA((tx) => tx.select().from(tradingAccounts)))[0]!.id;
  s1 = await strategy('S1');
  s2 = await strategy('S2');

  const day1 = [fill(s1.runtimeId, demoA, 'buy', 10, 100, 1)];
  const day2 = [...day1, fill(s2.runtimeId, idx, 'buy', 5, 200, 2)];
  const day3 = [...day2, fill(s1.runtimeId, demoA, 'sell', 10, 120, 3)];
  await close(1, day1, marks([[demoA, 110]]), [[demoA, 10]]);
  // The broker also holds 3 DEMO-B the app never bought.
  await close(
    2,
    day2,
    marks([
      [demoA, 90],
      [idx, 210],
    ]),
    [
      [demoA, 10],
      [idx, 5],
      [demoB, 3],
    ],
  );
  await close(3, day3, marks([[idx, 190]]), [[idx, 5]]);
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('performanceTimeseries', () => {
  it('shows account equity, P&L and drawdown by session', async () => {
    const series = await asA((tx) => performanceTimeseries(tx, {}));
    expect(series.filtered).toBe(false);
    expect(series.points).toEqual([
      {
        date: '2026-10-05',
        equity: '100100.00',
        pnl: '100.00',
        drawdown: '0.00',
        drawdownPct: '0.00',
        final: true,
      },
      {
        date: '2026-10-06',
        equity: '99950.00',
        pnl: '-50.00',
        drawdown: '150.00',
        drawdownPct: '0.15',
        final: true,
      },
      {
        date: '2026-10-07',
        equity: '100150.00',
        pnl: '150.00',
        drawdown: '0.00',
        drawdownPct: '0.00',
        final: true,
      },
    ]);
  });

  it('shows P&L only, in dollars, for one strategy', async () => {
    const series = await asA((tx) => performanceTimeseries(tx, { strategyIds: [s2.strategyId] }));
    expect(series.filtered).toBe(true);
    expect(series.points.map((p) => [p.date, p.equity, p.pnl, p.drawdown])).toEqual([
      ['2026-10-06', null, '50.00', '0.00'],
      ['2026-10-07', null, '-50.00', '100.00'],
    ]);
  });

  it('measures P&L from the start of a date range', async () => {
    const series = await asA((tx) => performanceTimeseries(tx, { from: '2026-10-06' }));
    expect(series.points.map((p) => [p.date, p.pnl])).toEqual([
      ['2026-10-06', '-150.00'],
      ['2026-10-07', '50.00'],
    ]);
  });
});

describe('performanceSummary', () => {
  it('adds up the account: returns, P&L, capital, contributions and broker differences', async () => {
    const s = await asA((tx) => performanceSummary(tx, {}));
    expect(s).toMatchObject({
      currency: 'USD',
      filtered: false,
      equity: {
        start: '100000.00',
        end: '100150.00',
        returnPct: '0.15',
        maxDrawdownPct: '0.15',
        sharpe: null,
      },
      sessions: 3,
      shortHistory: true,
      pnl: { net: '150.00', realized: '200.00', unrealized: '-50.00', fees: '0.00' },
      peakCapital: '2000.00',
      returnOnPeakCapitalPct: '7.50',
    });
    expect(s.byStrategy).toEqual([
      expect.objectContaining({
        strategyName: 'S1',
        net: '200.00',
        peakCapital: '1000.00',
        returnOnPeakCapitalPct: '20.00',
      }),
      expect.objectContaining({
        strategyName: 'S2',
        net: '-50.00',
        peakCapital: '1000.00',
        returnOnPeakCapitalPct: '-5.00',
      }),
    ]);
    expect(s.byAsset.map((a) => [a.symbol, a.assetClass, a.net])).toEqual([
      ['DEMO-A', 'stock', '200.00'],
      ['DEMO-IDX', 'etf', '-50.00'],
    ]);
    expect(s.dataQuality.staleMarks).toBe(0);
    expect(s.dataQuality.lastValuedAt).toBe('2026-10-07T20:05:00.000Z');
    expect(s.dataQuality.differences).toEqual([
      expect.objectContaining({
        sessionDate: '2026-10-06',
        accountName: 'Demo paper account',
        positions: [{ instrumentId: demoB, symbol: 'DEMO-B', app: '0', broker: '3' }],
      }),
    ]);
  });

  it('narrows to a date range, an asset class or an account', async () => {
    const ranged = await asA((tx) =>
      performanceSummary(tx, { from: '2026-10-06', to: '2026-10-07' }),
    );
    expect(ranged.equity).toMatchObject({
      start: '100100.00',
      end: '100150.00',
      returnPct: '0.05',
    });
    expect(ranged.pnl.net).toBe('50.00');
    expect(ranged.sessions).toBe(2);

    const etfs = await asA((tx) => performanceSummary(tx, { assetClasses: ['etf'] }));
    expect(etfs).toMatchObject({
      filtered: true,
      pnl: { net: '-50.00' },
      equity: { returnPct: null },
    });
    expect(etfs.byStrategy.map((b) => b.strategyName)).toEqual(['S2']);

    const firstDay = await asA((tx) => performanceSummary(tx, { to: '2026-10-05' }));
    expect(firstDay.pnl).toMatchObject({ net: '100.00', unrealized: '100.00' });

    const elsewhere = await asA((tx) =>
      performanceSummary(tx, { accountIds: ['00000000-0000-4000-8000-000000000000'] }),
    );
    expect(elsewhere).toMatchObject({ sessions: 0, pnl: { net: '0.00' } });
  });

  it('is empty in live mode, which does not exist yet', async () => {
    const live = await asA((tx) => performanceSummary(tx, { mode: 'live' }));
    expect(live).toMatchObject({ sessions: 0, pnl: { net: '0.00' }, byStrategy: [] });
    expect((await asA((tx) => performanceTimeseries(tx, { mode: 'live' }))).points).toEqual([]);
    expect((await asA((tx) => performanceTrades(tx, { mode: 'live' }))).trades).toEqual([]);
  });

  it("never shows one tenant another's results", async () => {
    const b = await as(userB, (tx) => performanceSummary(tx, {}));
    expect(b).toMatchObject({ sessions: 0, byStrategy: [], byAsset: [], pnl: { net: '0.00' } });
    expect(b.dataQuality.differences).toEqual([]);
    expect((await as(userB, (tx) => performanceTimeseries(tx, {}))).points).toEqual([]);
    expect(
      (await as(userB, (tx) => performanceSummary(tx, { strategyIds: [s1.strategyId] })))
        .byStrategy,
    ).toEqual([]);
  });
});
