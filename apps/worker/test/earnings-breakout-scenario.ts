/**
 * The abandoned Earnings breakout back test (diagnosis 2026-11-11) as a test
 * scenario: an S&P 500-shaped group of N synthetic members, Check Entry daily,
 * Enter when the earnings window (−1, +1) holds AND this stock's Last ≥ 1.02 ×
 * its Low one bar ago (5-minute or daily), ranked by 1-month return (top 10),
 * $1,000 a pick, Exit when off best close since entry % > 1. Bars come from a
 * synthetic feed built the way the Alpaca provider builds them (Decimal fields).
 */
import { DEFAULT_BACKTEST_INPUTS } from '@tm/backtest';
import {
  createStrategy,
  provisionWorkspace,
  schema,
  startBacktest,
  withTenant,
  type Transaction,
} from '@tm/db';
import type { TestDatabase } from '@tm/db/testing';
import {
  CONTEXT_INSTRUMENT_ID as C,
  addDays,
  createDefinition,
  DEMO_VENUE_CODE,
  parseDefinition,
  regularSession,
  type Bar,
  type BarRequest,
  type HistoricalDataProvider,
} from '@tm/domain';
import Decimal from 'decimal.js';

export interface ScenarioConfig {
  members: number;
  /** First and last day of the back test. */
  from: string;
  to: string;
  price: '5m' | '1d';
  earnings: boolean;
  ranking: boolean;
}

/** A deterministic random walk per symbol. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}
const seedOf = (symbol: string) => [...symbol].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

/** Bars as the Alpaca provider returns them: one object with five Decimals each. */
export function syntheticFeed(latencyMs = 0) {
  const calls = { count: 0 };
  const provider: HistoricalDataProvider = {
    id: 'synthetic',
    intervals: ['5m', '1d'],
    async getBars(req: BarRequest) {
      calls.count++;
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const next = rng(seedOf(req.symbol) ^ (req.interval === '5m' ? 99 : 1));
      let price = 50 + next() * 200;
      const bars: Bar[] = [];
      for (let day = req.from; day <= req.to; day = addDays(day, 1)) {
        const session = regularSession(day);
        if (!session) continue;
        const open = Date.parse(session.open);
        const close = Date.parse(session.close);
        const step = req.interval === '5m' ? 300_000 : close - open;
        for (let t = open; t < close; t += step) {
          const o = price;
          // Now and then a 3% jump, so the 2% breakout condition can fire.
          const jump = next() < (req.interval === '5m' ? 0.002 : 0.05) ? 1.03 : 1;
          price = Math.max(
            1,
            price * jump * (1 + (next() - 0.5) * (req.interval === '5m' ? 0.006 : 0.04)),
          );
          const hi = Math.max(o, price) * (1 + next() * 0.003);
          const lo = Math.min(o, price) * (1 - next() * 0.003);
          bars.push({
            start: new Date(t).toISOString(),
            end: new Date(Math.min(t + step, close)).toISOString(),
            open: new Decimal(o.toFixed(2)),
            high: new Decimal(hi.toFixed(2)),
            low: new Decimal(lo.toFixed(2)),
            close: new Decimal(price.toFixed(2)),
            volume: new Decimal(Math.round(1000 + next() * 50_000)),
          });
        }
      }
      return { bars, dataVersion: 'synthetic@1', warnings: [] };
    },
  };
  return { provider, calls };
}

/** Seeds a user, the synthetic members with earnings, and the strategy. */
export async function createScenario(t: TestDatabase, cfg: ScenarioConfig) {
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'diag', email: 'diag@example.test' })
    .returning({ id: schema.users.id });
  const userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Diag' });
  const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
  const account = (await asUser((tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;

  // N synthetic S&P 500 members, each with quarterly earnings releases.
  const symbols = Array.from({ length: cfg.members }, (_, i) => `SYN${String(i).padStart(3, '0')}`);
  const rows = await t.owner.db
    .insert(schema.instruments)
    .values(
      symbols.map((symbol) => ({
        assetClass: 'stock' as const,
        symbol,
        // The demo venue, so the default demo account can trade the list.
        venue: DEMO_VENUE_CODE,
        currency: 'USD',
        displayName: symbol,
        tickSize: '0.01',
      })),
    )
    .returning({ id: schema.instruments.id, symbol: schema.instruments.symbol });
  const ids = rows.map((r) => r.id);
  const releases = symbols.flatMap((symbol, i) =>
    [
      '2025-01-28',
      '2025-04-29',
      '2025-07-29',
      '2025-10-28',
      '2026-01-27',
      '2026-04-28',
      '2026-07-28',
      '2026-10-27',
    ].map((d, q) => {
      const day = addDays(d, i % 20);
      return {
        symbol,
        cik: String(100000 + i),
        fiscalQuarterEnd: addDays(d, -28),
        announcedAt: new Date(`${day}T21:05:00Z`),
        announcedDate: day,
        accession: `0000000000-26-${String(i * 10 + q).padStart(6, '0')}`,
        filingUrl: 'https://example.test/filing',
      };
    }),
  );
  for (let i = 0; i < releases.length; i += 1000)
    await t.owner.db.insert(schema.earningsReleases).values(releases.slice(i, i + 1000));

  const px = (id: string, field: 'last' | 'low', offset: number) => ({
    kind: 'market' as const,
    id,
    instrumentId: C,
    field,
    interval: cfg.price,
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
    offset,
  });
  const children: unknown[] = [
    {
      kind: 'comparison',
      id: 'breakout',
      operator: 'gte',
      left: px('last', 'last', 0),
      right: {
        kind: 'calc',
        id: 'times',
        op: 'mul',
        args: [px('low1', 'low', 1), { kind: 'constant', id: 'k', value: '1.02' }],
      },
    },
  ];
  if (cfg.earnings)
    children.unshift({
      kind: 'comparison',
      id: 'window',
      operator: 'eq',
      left: {
        kind: 'metric',
        id: 'ew',
        metric: 'earnings.window',
        params: { fromDay: -1, toDay: 1 },
        instrumentId: C,
      },
      right: { kind: 'constant', id: 'one', value: '1' },
    });
  const base = createDefinition();
  const definition = parseDefinition({
    ...base,
    trade: {
      kind: 'group',
      // The synthetic members as a list, so the up-front size check sees the real count.
      universe: { type: 'list', instrumentIds: ids },
      ...(cfg.ranking
        ? {
            ranking: {
              metric: 'return',
              params: { lookbackMonths: '1', skipMonths: '0' },
              direction: 'desc',
              count: { type: 'fixed', value: 10 },
            },
          }
        : {}),
    },
    // Without a ranking the group needs its own cap on holdings (O147): the same 10.
    risk: cfg.ranking ? base.risk : { ...base.risk, maxInstrumentsHeld: 10 },
    entry: {
      ...base.entry,
      schedule: { which: 'every', bar: '1d', days: 'daily' },
      condition: { kind: 'group', id: 'eg', op: 'and', negate: false, children },
      orders: [
        {
          id: 'buy-each',
          legLabel: 'Buy each pick',
          instrumentId: C,
          accountId: account,
          side: 'buy',
          quantity: { type: 'notional', value: '1000', rounding: 'down' },
          orderType: 'market',
          timeInForce: 'day',
          timing: { mode: 'immediate' },
        },
      ],
    },
    exit: {
      ...base.exit,
      condition: {
        kind: 'group',
        id: 'xg',
        op: 'and',
        negate: false,
        children: [
          {
            kind: 'comparison',
            id: 'trail',
            operator: 'gt',
            left: {
              kind: 'position',
              id: 'off',
              instrumentId: C,
              field: 'off_peak_pct',
              interval: '1d',
              adjustment: 'split_and_dividend',
              session: 'regular',
              offset: 0,
            },
            right: { kind: 'constant', id: 'pct', value: '1' },
          },
        ],
      },
      orders: [
        {
          id: 'close-each',
          legLabel: 'Close each pick',
          instrumentId: C,
          accountId: account,
          side: 'close',
          quantity: { type: 'units', value: '1', rounding: 'down' },
          orderType: 'market',
          timeInForce: 'day',
          timing: { mode: 'immediate' },
        },
      ],
    },
  });
  const s = await asUser((tx) =>
    createStrategy(tx, userId, { name: 'Earnings breakout (diag copy)', definition }),
  );
  return {
    userId,
    ids,
    strategyId: s.id,
    asUser,
    /** Queues the run, or returns why it was refused up front. */
    async start(): Promise<{ runId: string } | { refused: string }> {
      try {
        const run = await asUser((tx) =>
          startBacktest(tx, userId, s.id, {
            ...DEFAULT_BACKTEST_INPUTS,
            from: cfg.from,
            to: cfg.to,
          }),
        );
        return { runId: run.id };
      } catch (e) {
        const err = e as { details?: unknown; message?: string };
        if (err.details !== undefined) throw e;
        return { refused: err.message ?? '' };
      }
    },
  };
}
