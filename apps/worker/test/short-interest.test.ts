import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, loadEventData, registerInstrument, schema, shortInterestCoverage } from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  addDays,
  eventPointAt,
  FACTOR_CATALOGUE_V1,
  getMetric,
  regularSession,
  shortInterestPublicationDate,
} from '@tm/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_FINRA_API_URL,
  FAKE_FINRA_ID,
  FAKE_FINRA_SECRET,
  FAKE_FINRA_TOKEN_URL,
  FakeFinra,
  finraRow,
} from '../src/short-interest/fake';
import { finraClient } from '../src/short-interest/finra';
import { runShortInterestPass } from '../src/short-interest/job';

/**
 * FINRA short interest end to end against the fake (data inputs part 2,
 * item B, N323): ingest and resume, symbol resolution and the unresolved
 * report, point-in-time reads by publication date (B3), revisions keeping
 * their first publication date, the history floor (B5), the coverage report
 * (B4), and FINRA's own AAPL rows stored exactly as published (B2's shape).
 */

const FIX = join(__dirname, 'fixtures', 'finra');
const quiet = { info: () => undefined, warn: () => undefined };
const AAPL_ROWS = (
  JSON.parse(readFileSync(join(FIX, 'aapl-consolidated-short-interest.json'), 'utf8')) as {
    rows: Record<string, unknown>[];
  }
).rows;

let t: TestDatabase;
const ids: Record<string, string> = {};
const fake = new FakeFinra();
const client = finraClient({
  clientId: FAKE_FINRA_ID,
  clientSecret: FAKE_FINRA_SECRET,
  apiUrl: FAKE_FINRA_API_URL,
  tokenUrl: FAKE_FINRA_TOKEN_URL,
  fetch: fake.fetch,
});
const NOW = new Date('2026-11-23T15:00:00Z');
const pass = (perPass = 6) =>
  runShortInterestPass(
    {
      db: t.worker.db,
      client,
      logger: quiet,
      now: () => NOW,
      perPass,
      members: async () => [ids.AAPL!, ids['BRK.B']!, ids.NOROW!],
    },
    {},
  );
const SETTLEMENTS = ['2017-12-29', '2018-01-12', '2018-01-31', '2026-10-15', '2026-10-30'];

beforeAll(async () => {
  t = await createTestDatabase();
  for (const [symbol, assetClass] of [
    ['AAPL', 'stock'],
    ['BRK.B', 'stock'],
    ['NOROW', 'stock'],
    ['TSLA', 'stock'],
  ] as const)
    ids[symbol] = await t.worker.db.transaction((tx) =>
      registerInstrument(tx, {
        assetClass,
        symbol,
        venue: 'NASDAQ',
        displayName: symbol,
        provider: 'alpaca',
        providerId: `${symbol}-si-test`,
      }),
    );
  fake.add(AAPL_ROWS);
  for (const d of SETTLEMENTS) {
    fake.add([
      finraRow('BRKB', d, 8_000_000, 7_500_000, 4_000_000),
      // An OTC name the app doesn't know: reported, not stored.
      finraRow('ZZOTCF', d, 1000, 0, 0),
    ]);
  }
  // TSLA: a zero prior and no volume (999.99 days to cover) on the first settlement.
  fake.add([finraRow('TSLA', '2017-12-29', 30_000_000, 0, 0)]);
  fake.add([finraRow('TSLA', '2018-01-12', 30_684_061, 30_434_366, 6_245_967)]);
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

describe('ingest', () => {
  it('backfills newest first, a few settlements a pass, and resumes', async () => {
    const first = await pass(2);
    expect(first.fetched).toEqual(['2026-10-30', '2026-10-15']);
    expect(first.pending).toBe(3);
    const second = await pass(2);
    expect(second.fetched).toEqual(['2018-01-31', '2018-01-12']);
    const third = await pass(2);
    expect(third.fetched).toEqual(['2017-12-29']);
    expect(third.pending).toBe(0);
    // Nothing new: no settlement fetched again (the latest is re-checked once a day).
    const fourth = await pass(2);
    expect(fourth.fetched).toEqual([]);
  });

  it('stores FINRA rows exactly as published (B2 shape) with source and recorded time', async () => {
    const [row] = await t.app.db
      .select()
      .from(schema.shortInterest)
      .where(eq(schema.shortInterest.instrumentId, ids.AAPL!))
      .orderBy(schema.shortInterest.settlementDate);
    const raw = AAPL_ROWS[0]!;
    expect(row).toMatchObject({
      settlementDate: raw.settlementDate,
      availableDate: shortInterestPublicationDate(String(raw.settlementDate)),
      symbol: 'AAPL',
      shortShares: String(raw.currentShortPositionQuantity),
      daysToCover: String(raw.daysToCoverQuantity),
      avgDailyVolume: String(raw.averageDailyVolumeQuantity),
      changeShares: String(raw.changePreviousNumber),
      source: 'finra',
    });
    expect(row?.recordedAt).toBeInstanceOf(Date);
  });

  it('resolves BRKB to BRK.B and reports unknown symbols instead of dropping them silently', async () => {
    const brk = await t.app.db
      .select()
      .from(schema.shortInterest)
      .where(eq(schema.shortInterest.instrumentId, ids['BRK.B']!));
    expect(brk.length).toBe(5);
    expect(brk[0]?.symbol).toBe('BRKB');
    const [s] = await t.app.db
      .select()
      .from(schema.shortInterestSettlement)
      .where(eq(schema.shortInterestSettlement.settlementDate, '2017-12-29'));
    expect(s).toMatchObject({
      published: 4,
      stored: 3,
      unresolved: 1,
      unresolvedSymbols: ['ZZOTCF'],
    });
  });

  it('B5: the January 2018 settlements are in the table', async () => {
    const rows = await t.ownerSql<{ n: number }[]>`
      select count(*)::int as n from short_interest
      where settlement_date between '2018-01-01' and '2018-01-31'`;
    expect(rows[0]?.n).toBe(5);
  });
});

describe('B3: read by publication date', () => {
  const closeOf = (d: string) => Date.parse(regularSession(d)?.close ?? `${d}T21:00:00Z`);
  it('reads unknown the day before publication and the value on it, for all three metrics', async () => {
    const data = await loadEventData(
      t.app.db,
      new Map([[ids.AAPL!, new Set(['short.shares', 'short.days_to_cover', 'short.change_pct'])]]),
    );
    const available = shortInterestPublicationDate('2017-12-29');
    expect(available).toBe('2018-01-10');
    const dayBefore = '2018-01-09';
    for (const m of ['short.shares', 'short.days_to_cover', 'short.change_pct'])
      expect(eventPointAt(data, ids.AAPL!, m, closeOf(dayBefore), undefined), m).toBeUndefined();
    const at = (m: string, d: string) => eventPointAt(data, ids.AAPL!, m, closeOf(d), undefined);
    expect(at('short.shares', available)?.value.toNumber()).toBe(45746430);
    expect(at('short.days_to_cover', available)?.value.toNumber()).toBe(1.91);
    expect(at('short.change_pct', available)?.value.toNumber()).toBeCloseTo(
      -6407294 / 52153724,
      12,
    );
    expect(at('short.shares', available)?.asOfDate).toBe('2017-12-29');
    // Carried forward until the next publication, then the next settlement.
    const nextAvailable = shortInterestPublicationDate('2018-01-12');
    expect(at('short.shares', addDays(nextAvailable, -1))?.value.toNumber()).toBe(45746430);
    expect(at('short.shares', nextAvailable)?.value.toNumber()).toBe(46689117);
  });

  it('reads unknown change with a zero prior and unknown days to cover without volume', async () => {
    const data = await loadEventData(
      t.app.db,
      new Map([[ids.TSLA!, new Set(['short.days_to_cover', 'short.change_pct', 'short.shares'])]]),
    );
    const d = shortInterestPublicationDate('2017-12-29');
    const at = (m: string) => eventPointAt(data, ids.TSLA!, m, closeOf(d), undefined);
    expect(at('short.shares')?.value.toNumber()).toBe(30_000_000);
    expect(at('short.change_pct')).toBeUndefined();
    expect(at('short.days_to_cover')).toBeUndefined();
  });
});

describe('revisions', () => {
  it('a re-read replaces the figures but keeps the first publication date', async () => {
    const before = await t.app.db
      .select()
      .from(schema.shortInterest)
      .where(eq(schema.shortInterest.settlementDate, '2026-10-30'));
    const aapl = before.find((r) => r.instrumentId === ids.AAPL)!;
    fake.add([
      { ...AAPL_ROWS.at(-1)!, currentShortPositionQuantity: 145_000_000, revisionFlag: 'R' },
    ]);
    // A new day: the latest settlement is re-read.
    const r = await runShortInterestPass(
      { db: t.worker.db, client, logger: quiet, now: () => new Date('2026-11-24T15:00:00Z') },
      {},
    );
    expect(r.rechecked).toBe('2026-10-30');
    const after = await t.app.db
      .select()
      .from(schema.shortInterest)
      .where(eq(schema.shortInterest.settlementDate, '2026-10-30'));
    const revised = after.find((x) => x.instrumentId === ids.AAPL)!;
    expect(revised.shortShares).toBe('145000000');
    expect(revised.revisionFlag).toBe('R');
    expect(revised.availableDate).toBe(aapl.availableDate);
    expect(revised.recordedAt.getTime()).toBeGreaterThanOrEqual(aapl.recordedAt.getTime());
  });
});

describe('B4: the coverage report', () => {
  it('spans the settlements and counts members with no row per year, as found', async () => {
    const cov = await shortInterestCoverage(t.app.db, [ids.AAPL!, ids['BRK.B']!, ids.NOROW!]);
    expect(cov).toMatchObject({ settlements: 5, first: '2017-12-29', last: '2026-10-30' });
    expect(cov.missingByYear).toEqual([
      { year: 2017, settlements: 1, members: 3, missing: 1 },
      { year: 2018, settlements: 2, members: 3, missing: 1 },
      { year: 2026, settlements: 2, members: 3, missing: 1 },
    ]);
  });
});

describe('metrics and factors', () => {
  it('offers the three metrics and the two factors', () => {
    for (const id of ['short.days_to_cover', 'short.shares', 'short.change_pct'])
      expect(getMetric(id)?.category).toBe('short');
    expect(getMetric('short.shares')?.help).toMatch(/published/);
    const f = FACTOR_CATALOGUE_V1.filter((x) => x.category === 'short').map((x) => x.id);
    expect(f).toEqual(['short.days_to_cover', 'short.change_pct']);
  });
});

describe('an instrument registered later', () => {
  it('gets its history: settlements that listed its symbol are read again', async () => {
    const id = await t.worker.db.transaction((tx) =>
      registerInstrument(tx, {
        assetClass: 'stock',
        symbol: 'ZZOTCF',
        venue: 'OTC',
        displayName: 'ZZ',
        provider: 'alpaca',
        providerId: 'ZZOTCF-si-test',
      }),
    );
    let fetched: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await runShortInterestPass(
        {
          db: t.worker.db,
          client,
          logger: quiet,
          now: () => new Date('2026-11-24T16:00:00Z'),
          perPass: 2,
        },
        { recheckedOn: '2026-11-24' },
      );
      fetched = fetched.concat(r.fetched);
    }
    expect(fetched.sort()).toEqual([...SETTLEMENTS].sort());
    const rows = await t.app.db
      .select()
      .from(schema.shortInterest)
      .where(eq(schema.shortInterest.instrumentId, id));
    expect(rows.length).toBe(5);
    // Publication dates are the schedule's, as for the first read.
    expect(rows.find((r) => r.settlementDate === '2018-01-12')?.availableDate).toBe(
      shortInterestPublicationDate('2018-01-12'),
    );
  });
});
