import { and, asc, eq, registerInstrument, schema } from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  FEATURE_SET_V1,
  computeFeatures,
  predictionDates,
  regularSession,
  tradingDayAfter,
  tradingDays,
  type Bar,
  type FundamentalObservation,
  type HistoricalDataProvider,
} from '@tm/domain';
import { MarketView, loadData, planExprs } from '@tm/backtest';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FundamentalsLoader } from '../src/fundamentals';
import { featureSeries, runSnapshotPass } from '../src/ml/snapshots';

/**
 * The ML feature snapshot job (ML brief v1 §5) on synthetic bars and filings,
 * with the TypeScript half of the no-leakage fixture (§12 check 1): after
 * every input dated after T is changed (prices doubled, a filing restated),
 * the snapshots and labels for dates up to T come out byte-identical. The
 * trainer's half (same inputs → same predictions) is in apps/ml-trainer.
 */

let t: TestDatabase;
const members: string[] = [];
const SYMBOLS = ['MLA', 'MLB', 'MLC', 'MLD', 'MLE', 'MLF'];
const T = '2025-12-31';
const NOW = new Date('2026-03-16T15:00:00Z');
const quiet = { info: () => undefined, warn: () => undefined };
/** Every v1 feature but SUE: the events store is empty in this test (SUE stays null). */
const FEATURES = FEATURE_SET_V1.filter((f) => f.name !== 'sue');

/** Deterministic random walk per symbol; after T, optionally doubled. */
function provider(mutateAfterT: boolean): HistoricalDataProvider {
  return {
    id: 'ml-test',
    intervals: ['1d'],
    async getBars(req) {
      const k = SYMBOLS.indexOf(req.symbol);
      let s = 1000 + k * 7919;
      const rand = () => {
        s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
        return s / 2_147_483_648;
      };
      let price = 50 + k * 10;
      const bars: Bar[] = [];
      // The walk starts on a fixed day so every request sees the same prices.
      for (const d of tradingDays('2023-01-03', req.to)) {
        price *= 1 + (rand() - 0.5) * 0.04 + (k - 2.5) * 0.0004;
        if (d < req.from) continue;
        const session = regularSession(d);
        if (!session) continue;
        // Raw closes stay above the adjusted ones (dividends), splits none.
        const factor = req.adjustment === 'split_and_dividend' ? 1 : 1.01;
        let v = new Decimal(price * factor).toDecimalPlaces(4);
        if (mutateAfterT && d > T) v = v.times(2);
        bars.push({
          start: session.open,
          end: session.close,
          open: v,
          high: v,
          low: v,
          close: v,
          volume: v,
        });
      }
      return { bars, dataVersion: 'ml-test@1', warnings: [] };
    },
  };
}

/** Quarterly filings per member; with `restate`, a filing after T restates EPS. */
function fundamentals(restate: boolean): FundamentalsLoader {
  return async (_userId, list) => {
    const byId = new Map<string, FundamentalObservation[]>();
    for (const { id, symbol } of list) {
      const k = SYMBOLS.indexOf(symbol);
      const obs: FundamentalObservation[] = [];
      for (const q of [
        '2024-03-31',
        '2024-06-30',
        '2024-09-30',
        '2024-12-31',
        '2025-03-31',
        '2025-06-30',
        '2025-09-30',
        '2025-12-31',
      ]) {
        const filed = new Date(Date.parse(`${q}T20:00:00Z`) + 40 * 86_400_000).toISOString();
        const base = {
          periodEnd: q,
          availableFrom: filed,
          accession: `${symbol}-${q}`,
          form: '10-Q',
        };
        obs.push({ ...base, field: 'eps_ttm', value: String(2 + k * 0.3) });
        obs.push({ ...base, field: 'dps_ttm', value: String(k % 2 === 0 ? 0.5 + k * 0.1 : 0) });
        obs.push({ ...base, field: 'shares', value: '1000000' });
      }
      if (restate)
        obs.push({
          field: 'eps_ttm',
          value: '-9',
          periodEnd: '2025-09-30',
          availableFrom: '2026-01-15T21:00:00.000Z',
          accession: `${symbol}-restated`,
          form: '10-Q/A',
        });
      obs.sort((a, b) => a.availableFrom.localeCompare(b.availableFrom));
      byId.set(id, obs);
    }
    return { byId, warnings: [], unsynced: 0 };
  };
}

async function newModel(key: string): Promise<string> {
  const [row] = await t.owner.db
    .insert(schema.mlModels)
    .values({
      modelKey: key,
      name: key,
      universe: 'test',
      featureSet: FEATURES.map((f) => f.name),
      featureSetVersion: 1,
      label: { horizonTradingDays: 21 },
      algorithm: 'ridge',
      snapshotsFrom: '2025-06-01',
    })
    .returning({ id: schema.mlModels.id });
  return row!.id;
}

async function run(key: string, mutated: boolean, chunkDates = 4) {
  return runSnapshotPass({
    db: t.worker.db,
    history: provider(mutated),
    fundamentals: fundamentals(mutated),
    members: async () => members,
    userId: '00000000-0000-4000-8000-000000000001',
    now: () => NOW,
    logger: quiet,
    modelKeys: [key],
    features: FEATURES,
    chunkDates,
    batchSize: 4,
  });
}

async function rowsOf(modelId: string) {
  const snaps = await t.owner.db
    .select()
    .from(schema.mlFeatureSnapshots)
    .where(eq(schema.mlFeatureSnapshots.modelId, modelId))
    .orderBy(asc(schema.mlFeatureSnapshots.asOf), asc(schema.mlFeatureSnapshots.instrumentId));
  const labels = await t.owner.db
    .select()
    .from(schema.mlLabels)
    .where(eq(schema.mlLabels.modelId, modelId))
    .orderBy(asc(schema.mlLabels.asOf), asc(schema.mlLabels.instrumentId));
  return {
    snaps: snaps.map((r) => ({ asOf: r.asOf, id: r.instrumentId, f: r.features, raw: r.raw })),
    labels: labels.map((r) => ({
      asOf: r.asOf,
      id: r.instrumentId,
      end: r.labelEnd,
      ret: r.forwardReturn,
    })),
  };
}

beforeAll(async () => {
  t = await createTestDatabase();
  for (const symbol of SYMBOLS)
    members.push(
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
});

afterAll(async () => {
  await t?.drop();
});

describe('ML feature snapshots (brief §5)', () => {
  let clean: Awaited<ReturnType<typeof rowsOf>>;
  let modelId: string;

  it('writes one row per member per month end before today, with z-scored features', async () => {
    modelId = await newModel('snap-clean');
    const r = await run('snap-clean', false);
    const dates = predictionDates('2025-06-01', '2026-03-13');
    expect(r.snapshots).toEqual(dates);
    clean = await rowsOf(modelId);
    expect(clean.snaps).toHaveLength(dates.length * members.length);
    // Each feature's z-scores average 0 across the members that have it.
    const first = clean.snaps.filter((s) => s.asOf === dates[0]);
    for (const f of FEATURES) {
      const zs = first
        .map((s) => (s.f as Record<string, number | null>)[f.name])
        .filter((v) => v !== null) as number[];
      expect(zs.length).toBe(members.length);
      expect(Math.abs(zs.reduce((a, v) => a + v, 0))).toBeLessThan(1e-9);
    }
  });

  it('stores exactly what a strategy condition reads that day (principle 3)', async () => {
    const date = '2025-09-30';
    const refs = new Map(
      members.map((id, i) => [
        id,
        { symbol: SYMBOLS[i] as string, assetClass: 'stock', lotSize: '1' },
      ]),
    );
    const data = await loadData(
      provider(false),
      planExprs(
        members.flatMap((id) => featureSeries(id, FEATURES)),
        '2025-06-01',
        date,
      ),
      refs,
    );
    data.fundamentals = (
      await fundamentals(false)(
        'u',
        members.map((id, i) => ({ id, symbol: SYMBOLS[i] as string })),
      )
    ).byId;
    const view = new MarketView(data.series, new Set(), data.fundamentals);
    view.advance(Date.parse(regularSession(date)!.close));
    for (const id of members) {
      const stored = clean.snaps.find((s) => s.asOf === date && s.id === id)!.raw;
      expect(stored).toEqual(computeFeatures(id, view, FEATURES));
    }
  });

  it('records realised 21-day forward returns once their window has closed', async () => {
    const dates = predictionDates('2025-06-01', '2026-03-13').filter(
      (d) => tradingDayAfter(d) <= '2026-03-13',
    );
    expect([...new Set(clean.labels.map((l) => l.asOf))]).toEqual(dates);
    for (const l of clean.labels) expect(l.end).toBe(tradingDayAfter(l.asOf));
  });

  it('reports when each feature first covers 90% of members', async () => {
    const [m] = await t.owner.db
      .select()
      .from(schema.mlModels)
      .where(eq(schema.mlModels.id, modelId));
    expect(m?.availability).toMatchObject({ mom_12_1: '2025-06-30', pe: '2025-06-30' });
  });

  it('does nothing on a second pass', async () => {
    const r = await run('snap-clean', false);
    expect(r.snapshots).toEqual([]);
    expect(r.labels).toBe(0);
  });

  it('no-leakage fixture (§12.1): changing every input after T leaves dates up to T byte-identical', async () => {
    const mutatedId = await newModel('snap-mutated');
    // A different chunking too: the result must not depend on how the job splits its work.
    await run('snap-mutated', true, 5);
    const mutated = await rowsOf(mutatedId);
    const upToT = (rows: { asOf: string }[]) => rows.filter((r) => r.asOf <= T);
    expect(JSON.stringify(upToT(mutated.snaps))).toBe(JSON.stringify(upToT(clean.snaps)));
    // Labels whose window ended by T are inputs the trainer may use for T; they match too.
    const realised = (rows: { end: string }[]) => rows.filter((r) => r.end <= T);
    expect(JSON.stringify(realised(mutated.labels))).toBe(JSON.stringify(realised(clean.labels)));
    // And the change is real: snapshots after T differ.
    const after = (rows: { asOf: string }[]) => rows.filter((r) => r.asOf > T);
    expect(JSON.stringify(after(mutated.snaps))).not.toBe(JSON.stringify(after(clean.snaps)));
    const rows = await t.owner.db
      .select()
      .from(schema.mlFeatureSnapshots)
      .where(
        and(
          eq(schema.mlFeatureSnapshots.modelId, mutatedId),
          eq(schema.mlFeatureSnapshots.asOf, T),
        ),
      );
    expect(rows).toHaveLength(members.length);
  });
});
