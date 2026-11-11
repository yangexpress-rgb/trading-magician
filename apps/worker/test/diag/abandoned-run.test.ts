/**
 * Reproduction of the abandoned Earnings breakout back tests (diagnosis
 * 2026-11-11). Off unless DIAG_BACKTEST=1, so CI never runs it. One
 * configuration per process, so memory readings start clean:
 *
 *   DIAG_BACKTEST=1 DIAG_MEMBERS=100 DIAG_MONTHS=12 DIAG_PRICE=5m DIAG_EARNINGS=1 \
 *   DIAG_RANKING=1 DIAG_OUT=/path/out.jsonl TEST_DATABASE_URL=… \
 *   pnpm --filter @tm/worker exec vitest run test/diag/abandoned-run.test.ts
 *
 * The strategy has the shape of S00009-SN Version 2 as Yong described it: an
 * S&P 500 group (here N synthetic members), Check Entry daily after the close,
 * Enter when the earnings window (−1, +1) holds AND this stock's 5-minute Last
 * ≥ 1.02 × its 5-minute Low one bar ago, ranked by 1-month return (top 10),
 * $1,000 a pick, Exit when off best close since entry % > 1. Bars come from a
 * synthetic feed built the way the Alpaca provider builds them (Decimal
 * fields), with no network wait unless DIAG_LATENCY_MS is set.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { DEFAULT_BACKTEST_INPUTS } from '@tm/backtest';
import {
  createStrategy,
  getBacktest,
  provisionWorkspace,
  schema,
  startBacktest,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  CONTEXT_INSTRUMENT_ID as C,
  addDays,
  createDefinition,
  nyDate,
  parseDefinition,
  regularSession,
  type Bar,
  type BarRequest,
  type HistoricalDataProvider,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { afterAll, describe, expect, it } from 'vitest';
import { processNextRun } from '../../src/backtests';

const on = process.env.DIAG_BACKTEST === '1';
const MEMBERS = Number(process.env.DIAG_MEMBERS ?? 25);
const MONTHS = Number(process.env.DIAG_MONTHS ?? 1);
const PRICE = (process.env.DIAG_PRICE ?? '5m') as '5m' | '1d';
const EARNINGS = process.env.DIAG_EARNINGS !== '0';
const RANKING = process.env.DIAG_RANKING !== '0';
const LATENCY = Number(process.env.DIAG_LATENCY_MS ?? 0);
const OUT = process.env.DIAG_OUT;
const TO = '2026-11-07';
const FROM = MONTHS >= 12 ? '2025-11-08' : addDays(TO, -Math.round(MONTHS * 30.4));

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
const syntheticFeed: HistoricalDataProvider = {
  id: 'synthetic',
  intervals: ['5m', '1d'],
  async getBars(req: BarRequest) {
    if (LATENCY > 0) await new Promise((r) => setTimeout(r, LATENCY));
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

let t: TestDatabase | undefined;

afterAll(async () => {
  await t?.drop();
});

describe.runIf(on)('abandoned back test reproduction', () => {
  it(`${MEMBERS} members, ${MONTHS} months, ${PRICE} Last/Low, earnings ${EARNINGS}, ranking ${RANKING}`, async () => {
    t = await createTestDatabase();
    const [user] = await t.auth.db
      .insert(schema.users)
      .values({ name: 'diag', email: 'diag@example.test' })
      .returning({ id: schema.users.id });
    const userId = user!.id;
    await provisionWorkspace(t.app.db, { userId, displayName: 'Diag' });
    const asUser = <T>(fn: (tx: Transaction) => Promise<T>) =>
      withTenant(t!.app.db, { userId }, fn);
    const account = (await asUser((tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;

    // N synthetic S&P 500 members, each with quarterly earnings releases.
    const symbols = Array.from({ length: MEMBERS }, (_, i) => `SYN${String(i).padStart(3, '0')}`);
    const rows = await t.owner.db
      .insert(schema.instruments)
      .values(
        symbols.map((symbol) => ({
          assetClass: 'stock' as const,
          symbol,
          venue: 'XNAS',
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
      interval: PRICE,
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
    if (EARNINGS)
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
        universe: { type: 'builtin', id: 'sp500' },
        ...(RANKING
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
      risk: RANKING ? base.risk : { ...base.risk, maxInstrumentsHeld: 10 },
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
    // The recorded run: daily bars, $100,000, splits and dividends (as stored for the failed runs).
    const run = await asUser((tx) =>
      startBacktest(tx, userId, s.id, { ...DEFAULT_BACKTEST_INPUTS, from: FROM, to: TO }),
    ).catch((e: { details?: unknown }) => {
      console.error(JSON.stringify(e.details, null, 1).slice(0, 3000));
      throw e;
    });

    const lines: Record<string, unknown>[] = [];
    const capture = (level: string) => (obj: unknown, msg?: string) => {
      if (obj && typeof obj === 'object' && 'event' in obj) {
        lines.push({ level, msg, ...obj });
        // Streamed too, so a run that dies (out of memory) leaves its last stage behind.
        if (OUT) appendFileSync(`${OUT}.events`, `${JSON.stringify({ level, msg, ...obj })}\n`);
      }
    };
    const logger = { info: capture('info'), warn: capture('warn'), error: capture('error') };
    const profile = process.env.DIAG_PROFILE;
    const inspector = profile ? new Session() : undefined;
    if (inspector) {
      inspector.connect();
      await inspector.post('Profiler.enable');
      await inspector.post('Profiler.start');
    }
    const t0 = Date.now();
    const outcome = await processNextRun({
      db: t.app.db,
      provider: syntheticFeed,
      workerId: 'diag-worker',
      logger,
      heartbeatMs: 5000,
      resolveUniverse: async () => ({ ids, warnings: [] }),
    });
    if (inspector && profile) {
      const { profile: cpu } = await inspector.post('Profiler.stop');
      writeFileSync(profile, JSON.stringify(cpu));
      inspector.disconnect();
    }
    const done = await asUser((tx) => getBacktest(tx, run.id));
    const config = {
      members: MEMBERS,
      months: MONTHS,
      from: FROM,
      to: TO,
      price: PRICE,
      earnings: EARNINGS,
      ranking: RANKING,
    };
    const summary = {
      config,
      outcome,
      totalMs: Date.now() - t0,
      cycles: done.metrics?.cycles ?? null,
      stages: lines.filter((l) => l.event === 'backtest.stage'),
      heartbeats: lines.filter((l) => l.event === 'backtest.heartbeat').length,
      final: lines.find((l) => l.event === 'backtest.summary'),
      error: done.error,
    };
    if (OUT) appendFileSync(OUT, `${JSON.stringify(summary)}\n`);
    expect(outcome).toBe('completed');
  }, 3_600_000);
});
