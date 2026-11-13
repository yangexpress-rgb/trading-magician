import { asc, factorCoverageReport, registerInstrument, schema } from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  regularSession,
  tradingDays,
  type Bar,
  type FundamentalObservation,
  type HistoricalDataProvider,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FundamentalsLoader } from '../src/fundamentals';
import { lastSnapshotDay, runPatternSnapshotPass } from '../src/patterns/snapshots';

/**
 * Pattern discovery's factor snapshot job (pattern brief §3) on synthetic
 * bars and filings: rows per member and day, the coverage counts, resuming,
 * the session factors for the options universe, and no leakage (§3: nothing
 * in a row may use data from after that day's close — after every input
 * dated after T is changed, rows up to T come out identical).
 */

let t: TestDatabase;
const ids: string[] = [];
const SYMBOLS = ['PTA', 'PTB', 'PTC', 'PTD'];
const T = '2025-10-31';
const NOW = new Date('2025-12-15T15:00:00Z');
const FROM = '2025-09-02';
const quiet = { info: () => undefined, warn: () => undefined };

function provider(mutateAfterT: boolean, calls?: { n: number }): HistoricalDataProvider {
  return {
    id: 'pattern-test',
    intervals: ['5m', '1d'],
    async getBars(req) {
      if (calls) calls.n++;
      const k = SYMBOLS.indexOf(req.symbol);
      let s = 4000 + k * 7919;
      const rand = () => {
        s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
        return s / 2_147_483_648;
      };
      let price = 40 + k * 15;
      const bars: Bar[] = [];
      for (const d of tradingDays('2023-01-03', req.to)) {
        price *= 1 + (rand() - 0.5) * 0.04;
        const session = regularSession(d);
        if (!session || d < req.from) continue;
        const factor = req.adjustment === 'split_and_dividend' ? 1 : 1.02;
        const bump = mutateAfterT && d > T ? 2 : 1;
        const px = (x: number) => new Decimal(x * factor * bump).toDecimalPlaces(4);
        if (req.interval === '1d') {
          bars.push({
            start: session.open,
            end: session.close,
            open: px(price),
            high: px(price * 1.01),
            low: px(price * 0.99),
            close: px(price),
            volume: new Decimal(1000 + Math.round(rand() * 500)),
          });
        } else {
          // Six 5-minute bars from the open, enough for the opening factors.
          const open = Date.parse(session.open);
          for (let j = 0; j < 6; j++) {
            const p = price * (1 + 0.001 * j);
            bars.push({
              start: new Date(open + j * 300_000).toISOString(),
              end: new Date(open + (j + 1) * 300_000).toISOString(),
              open: px(j === 0 ? price : price * (1 + 0.001 * (j - 1))),
              high: px(p * 1.002),
              low: px(p * 0.998),
              close: px(p),
              volume: new Decimal(100),
            });
          }
        }
      }
      return { bars, dataVersion: 'pattern-test@1', warnings: [] };
    },
  };
}

function fundamentals(restate: boolean): FundamentalsLoader {
  return async (_userId, list) => {
    const byId = new Map<string, FundamentalObservation[]>();
    for (const { id, symbol } of list) {
      const k = SYMBOLS.indexOf(symbol);
      const obs: FundamentalObservation[] = [];
      for (const [i, q] of [
        '2024-03-31',
        '2024-06-30',
        '2024-09-30',
        '2024-12-31',
        '2025-03-31',
        '2025-06-30',
        '2025-09-30',
      ].entries()) {
        const filed = new Date(Date.parse(`${q}T20:00:00Z`) + 35 * 86_400_000).toISOString();
        const base = {
          periodEnd: q,
          availableFrom: filed,
          accession: `${symbol}-${q}`,
          form: '10-Q',
        };
        obs.push({ ...base, field: 'revenue_ttm', value: String(1000 + k * 100 + i * 50) });
        obs.push({ ...base, field: 'ocf_ttm', value: String(200 + i * 10) });
        obs.push({ ...base, field: 'capex_ttm', value: String(50) });
        obs.push({ ...base, field: 'eps_ttm', value: String(2 + k * 0.3) });
        obs.push({ ...base, field: 'shares', value: '1000000' });
      }
      if (restate)
        obs.push({
          field: 'revenue_ttm',
          value: '1',
          periodEnd: '2025-09-30',
          availableFrom: '2025-11-20T21:00:00.000Z',
          accession: `${symbol}-restated`,
          form: '10-Q/A',
        });
      obs.sort((a, b) => a.availableFrom.localeCompare(b.availableFrom));
      byId.set(id, obs);
    }
    return { byId, warnings: [], unsynced: 0 };
  };
}

async function run(
  db: TestDatabase['worker']['db'],
  mutated: boolean,
  extra: { maxBatches?: number; batchSize?: number; attempts?: Map<string, string> } = {},
) {
  return runPatternSnapshotPass({
    db,
    history: provider(mutated),
    fundamentals: fundamentals(mutated),
    members: async () => ids,
    sessionMembers: async () => [ids[0] as string],
    userId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    from: FROM,
    logger: quiet,
    batchSize: extra.batchSize ?? 2,
    ...(extra.maxBatches !== undefined ? { maxBatches: extra.maxBatches } : {}),
    ...(extra.attempts ? { attempts: extra.attempts } : {}),
  });
}

async function rows(db: TestDatabase['owner']['db']) {
  const all = await db
    .select()
    .from(schema.factorSnapshots)
    .orderBy(asc(schema.factorSnapshots.asOf), asc(schema.factorSnapshots.instrumentId));
  return all.map((r) => ({
    asOf: r.asOf,
    id: r.instrumentId,
    values: r.values as Record<string, number>,
    bar: [r.closeRet, r.highRel, r.lowRel],
  }));
}

beforeAll(async () => {
  t = await createTestDatabase();
  for (const symbol of SYMBOLS)
    ids.push(
      await t.worker.db.transaction((tx) =>
        registerInstrument(tx, {
          assetClass: 'stock',
          symbol,
          venue: 'NYSE',
          displayName: symbol,
          provider: 'alpaca',
          providerId: `${symbol}-test`,
        }),
      ),
    );
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

describe('pattern factor snapshots', () => {
  it('backfills every member and day, resumes in batches, and counts coverage', async () => {
    const last = lastSnapshotDay(NOW);
    const days = tradingDays(FROM, last);
    const first = await run(t.worker.db, false, { maxBatches: 1 });
    expect(first.members).toBe(2);
    expect(first.pending).toBe(2);
    const second = await run(t.worker.db, false);
    expect(second.members).toBe(2);
    expect(second.pending).toBe(0);
    const all = await rows(t.owner.db);
    expect(all).toHaveLength(days.length * ids.length);
    // Nothing more to do; a second pass writes nothing.
    expect((await run(t.worker.db, false)).rows).toBe(0);

    const sample = all.find((r) => r.asOf === '2025-11-14' && r.id === ids[1]);
    expect(sample?.values.return_5d).toBeTypeOf('number');
    expect(sample?.values.return_252d).toBeTypeOf('number');
    expect(sample?.values.rsi_14).toBeTypeOf('number');
    expect(sample?.values.volatility_60).toBeTypeOf('number');
    expect(sample?.values.dist_52w_high).toBeLessThanOrEqual(0);
    expect(sample?.values.volume_ratio_60).toBeGreaterThan(0);
    expect(sample?.values.ma_distance_200).toBeTypeOf('number');
    expect(sample?.values.revenue_ttm).toBeTypeOf('number');
    expect(sample?.values.earnings_yield).toBeTypeOf('number');
    // Revenue 2025-09-30 (filed 2025-11-04) ÷ 2024-09-30 − 1, both as filed by then.
    expect(sample?.values.revenue_growth_yoy).toBeCloseTo((1100 + 300) / (1100 + 100) - 1, 10);
    expect(sample?.values.fcf_margin).toBeCloseTo((260 - 50) / 1400, 10);
    // No events or options stored: those factors are unknown (absent), never 0.
    expect(sample?.values['earnings.sue_ts']).toBeUndefined();
    expect(sample?.values['options.iv30']).toBeUndefined();
    // Session factors only for the options universe's member.
    expect(sample?.values['session.first5_return']).toBeUndefined();
    const s0 = all.find((r) => r.asOf === '2025-11-14' && r.id === ids[0]);
    expect(s0?.values['session.first5_return']).toBeCloseTo(0, 10);
    expect(s0?.values['session.first30_return']).toBeCloseTo(0.005, 4);
    expect(s0?.bar[1]).toBeGreaterThan(s0?.bar[0] as number);

    const report = await factorCoverageReport(t.owner.db);
    expect(report.rows).toBe(all.length);
    expect(report.days).toBe(days.length);
    expect(report.first).toBe(FROM);
    expect(report.instruments).toBe(ids.length);
    const line = report.factors.find((f) => f.factor === 'return_5d');
    expect(line?.known).toBe(all.filter((r) => r.values.return_5d !== undefined).length);
    // Four members never make a 50-strong cross-section.
    expect(line?.firstCross).toBeNull();
    const session = report.categories.find((c) => c.category === 'session');
    expect(session?.firstAny).toBe(FROM);
    expect(report.categories.find((c) => c.category === 'options')?.factorsWithData).toBe(0);
  }, 60_000);

  it('leaks nothing: rows up to T are identical after every later input changes', async () => {
    const other = await createTestDatabase();
    try {
      const otherIds: string[] = [];
      for (const symbol of SYMBOLS)
        otherIds.push(
          await other.worker.db.transaction((tx) =>
            registerInstrument(tx, {
              assetClass: 'stock',
              symbol,
              venue: 'NYSE',
              displayName: symbol,
              provider: 'alpaca',
              providerId: `${symbol}-test`,
            }),
          ),
        );
      const saved = ids.splice(0, ids.length, ...otherIds);
      await run(other.worker.db, true);
      ids.splice(0, ids.length, ...saved);
      const plainRows = (await rows(t.owner.db)).filter((r) => r.asOf <= T);
      const mutatedRows = (await rows(other.owner.db)).filter((r) => r.asOf <= T);
      const bySymbol = (list: typeof plainRows, idList: string[]) =>
        list
          .map((r) => ({ ...r, id: SYMBOLS[idList.indexOf(r.id)] as string }))
          .sort((a, b) => a.asOf.localeCompare(b.asOf) || a.id.localeCompare(b.id));
      expect(bySymbol(mutatedRows, otherIds)).toEqual(bySymbol(plainRows, ids));
      // And after T they do differ (the change was real).
      const after = (await rows(other.owner.db)).find((r) => r.asOf > T && r.values.revenue_ttm);
      expect(after).toBeDefined();
    } finally {
      await other.drop();
    }
  }, 120_000);

  it('skips a member without bars until a new day closes', async () => {
    const attempts = new Map<string, string>();
    const db = t.worker.db;
    const empty: HistoricalDataProvider = {
      id: 'empty',
      intervals: ['1d'],
      getBars: async () => ({ bars: [], dataVersion: 'x', warnings: [] }),
    };
    const extra = await db.transaction((tx) =>
      registerInstrument(tx, {
        assetClass: 'stock',
        symbol: 'PTZ',
        venue: 'NYSE',
        displayName: 'PTZ',
        provider: 'alpaca',
        providerId: 'PTZ-test',
      }),
    );
    const opts = {
      db,
      history: empty,
      fundamentals: fundamentals(false),
      members: async () => [extra],
      sessionMembers: async () => [],
      userId: '00000000-0000-4000-8000-000000000001',
      now: () => NOW,
      from: FROM,
      logger: quiet,
      attempts,
    };
    expect((await runPatternSnapshotPass(opts)).members).toBe(1);
    expect((await runPatternSnapshotPass(opts)).members).toBe(0);
  }, 30_000);
});
