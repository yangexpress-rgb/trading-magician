import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { Bar } from '../market/bars';
import { regularSession } from '../market/calendar';
import { latestObservation, type FundamentalObservation } from '../market/point-in-time';
import {
  barRatios,
  computeDailyFactors,
  fcfMargin,
  FACTOR_CATALOGUE_V1,
  FilingIndex,
  revenueGrowth,
  sessionFactors,
} from './factors';

const obs = (
  field: FundamentalObservation['field'],
  value: number,
  periodEnd: string,
  availableFrom: string,
  accession = `${field}-${periodEnd}-${availableFrom}`,
): FundamentalObservation => ({
  field,
  value: String(value),
  periodEnd,
  availableFrom,
  accession,
  form: '10-Q',
});

describe('factor catalogue v1 (pattern brief §4)', () => {
  it('has unique ids, a category and at least one atom mode for every factor', () => {
    const ids = FACTOR_CATALOGUE_V1.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FACTOR_CATALOGUE_V1) expect(f.modes.length).toBeGreaterThan(0);
    // The brief's named factors are all there.
    for (const id of [
      'return_5d',
      'return_252d',
      'rsi_14',
      'volatility_60',
      'dist_52w_high',
      'volume_ratio_60',
      'ma_distance_50',
      'ma_distance_200',
      'revenue_growth_yoy',
      'fcf_margin',
      'dividend_streak',
      'earnings.sue_ts',
      'deals.spread_pct',
      'rates.tbill_3m',
      'options.iv30',
      'options.expected_move_5d_pct',
      'session.first5_return',
      'session.close_position',
    ])
      expect(ids).toContain(id);
  });
});

describe('FilingIndex', () => {
  const list = [
    obs('eps_ttm', 1, '2024-03-31', '2024-05-01T20:00:00Z'),
    obs('revenue_ttm', 100, '2024-03-31', '2024-05-01T20:00:00Z'),
    obs('eps_ttm', 2, '2024-06-30', '2024-08-01T20:00:00Z'),
    obs('eps_ttm', 3, '2024-06-30', '2024-08-01T20:00:00Z', 'restated-same-time'),
    obs('eps_ttm', 4, '2024-09-30', '2024-11-01T20:00:00Z'),
  ];
  it('answers exactly as latestObservation does, including the age limit', () => {
    const index = new FilingIndex(list);
    for (const at of [
      '2024-04-01',
      '2024-05-02',
      '2024-08-01T19:00:00Z',
      '2024-08-02',
      '2024-12-01',
      '2026-03-01',
    ]) {
      const ms = Date.parse(at);
      expect(index.latest('eps_ttm', ms)).toEqual(latestObservation(list, 'eps_ttm', ms));
    }
  });
});

describe('derived fundamentals', () => {
  const at = Date.parse('2025-08-15T21:00:00Z');
  it('revenue growth is TTM revenue over the TTM four quarters earlier, as filed by then', () => {
    const filings = (restatedAt: string) =>
      new FilingIndex([
        obs('revenue_ttm', 100, '2024-06-30', '2024-08-01T20:00:00Z'),
        // A restatement of the year-ago period.
        obs('revenue_ttm', 50, '2024-06-30', restatedAt),
        obs('revenue_ttm', 125, '2025-06-30', '2025-08-01T20:00:00Z'),
      ]);
    // Restated after the date: the original year-ago figure.
    expect(revenueGrowth(filings('2025-09-01T20:00:00Z'), at)).toBeCloseTo(0.25, 12);
    // Restated before it: the restated one.
    expect(revenueGrowth(filings('2025-07-01T20:00:00Z'), at)).toBeCloseTo(1.5, 12);
    expect(revenueGrowth(new FilingIndex([]), at)).toBeUndefined();
  });
  it('FCF margin needs all three inputs for the same period', () => {
    const base = [
      obs('revenue_ttm', 200, '2025-06-30', '2025-08-01T20:00:00Z'),
      obs('ocf_ttm', 50, '2025-06-30', '2025-08-01T20:00:00Z'),
    ];
    expect(fcfMargin(new FilingIndex(base), at)).toBeUndefined();
    expect(
      fcfMargin(
        new FilingIndex([...base, obs('capex_ttm', 10, '2025-06-30', '2025-08-01T20:00:00Z')]),
        at,
      ),
    ).toBeCloseTo(0.2, 12);
    expect(
      fcfMargin(
        new FilingIndex([...base, obs('capex_ttm', 10, '2025-03-31', '2025-05-01T20:00:00Z')]),
        at,
      ),
    ).toBeUndefined();
  });
});

describe('price factors computed here', () => {
  const close = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.05);
  const volume = Array.from({ length: 300 }, (_, i) => (i === 299 ? 3000 : 1000));
  const reader = { value: () => undefined };
  const out = computeDailyFactors(
    'X',
    reader,
    { close, volume, at: 299 },
    undefined,
    0,
    new Set(['price']),
  );
  it('5-day return, distance to the 52-week high, volume ratio', () => {
    expect(out.return_5d).toBeCloseTo((close[299] as number) / (close[294] as number) - 1, 12);
    const high = Math.max(...close.slice(48, 300));
    expect(out.dist_52w_high).toBeCloseTo((close[299] as number) / high - 1, 12);
    expect(out.volume_ratio_60).toBeCloseTo(3, 12);
  });
  it('leaves a factor out when it cannot be worked out, never 0', () => {
    expect(out.rsi_14).toBeUndefined();
    const short = computeDailyFactors(
      'X',
      reader,
      { close, volume, at: 30 },
      undefined,
      0,
      new Set(['price']),
    );
    expect(short.dist_52w_high).toBeUndefined();
    expect(short.volume_ratio_60).toBeUndefined();
    expect(short.return_5d).toBeTypeOf('number');
  });
});

describe('session factors', () => {
  const date = '2025-11-14';
  const s = regularSession(date)!;
  const open = Date.parse(s.open);
  const bar = (j: number, o: number, h: number, l: number, c: number): Bar => ({
    start: new Date(open + j * 300_000).toISOString(),
    end: new Date(open + (j + 1) * 300_000).toISOString(),
    open: new Decimal(o),
    high: new Decimal(h),
    low: new Decimal(l),
    close: new Decimal(c),
    volume: new Decimal(1),
  });
  it('first 5 and 30 minutes, range and close position', () => {
    const bars = [
      bar(0, 100, 103, 99, 102),
      ...[1, 2, 3, 4].map((j) => bar(j, 102, 104, 101, 103)),
      bar(5, 103, 106, 98, 105),
      bar(6, 105, 105, 104, 104),
    ];
    const v = sessionFactors(date, bars);
    expect(v['session.first5_return']).toBeCloseTo(0.02, 12);
    expect(v['session.first30_return']).toBeCloseTo(0.05, 12);
    expect(v['session.range_pct']).toBeCloseTo(106 / 98 - 1, 12);
    expect(v['session.close_position']).toBeCloseTo((104 - 98) / (106 - 98), 12);
  });
  it('opening returns are unknown when the first bar is not the opening bar', () => {
    const v = sessionFactors(date, [bar(1, 100, 101, 99, 100), bar(2, 100, 102, 99, 101)]);
    expect(v['session.first5_return']).toBeUndefined();
    expect(v['session.range_pct']).toBeCloseTo(102 / 99 - 1, 12);
    expect(sessionFactors(date, [])).toEqual({});
  });
});

describe('bar ratios', () => {
  it('are the day against the previous close; unknown without one', () => {
    const r = barRatios(100, { close: 102, high: 105, low: 97 });
    expect(r?.closeRet).toBeCloseTo(0.02, 12);
    expect(r?.highRel).toBeCloseTo(0.05, 12);
    expect(r?.lowRel).toBeCloseTo(-0.03, 12);
    expect(barRatios(undefined, { close: 1, high: 1, low: 1 })).toBeUndefined();
  });
});
