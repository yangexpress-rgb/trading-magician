import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  latestObservation,
  type FundamentalField,
  type FundamentalObservation,
} from '../market/point-in-time';
import {
  computeMetric,
  formatMetric,
  fundamentalSnapshot,
  isFundamentalMetric,
  METRICS,
  sharesPerOldShare,
  type MetricReader,
} from './metrics';
import { fundamentalInstruments, usesFundamentals } from './selection';
import { context, STOCK_A, validDefinition } from './test-fixtures';
import { validateStrategy } from './validate';

const AS_OF = Date.parse('2025-06-02T21:00:00Z');

const obs = (
  field: FundamentalField,
  value: string,
  availableFrom = '2025-05-01T20:00:00.000Z',
  periodEnd = '2025-03-31',
): FundamentalObservation => ({
  field,
  value,
  periodEnd,
  availableFrom,
  accession: `a-${field}`,
  form: '10-Q',
});

/** A reader at AS_OF with a raw price, a split-adjusted price and some filings. */
function reader(
  list: FundamentalObservation[],
  opts: { raw?: number; splitFactorThen?: number } = {},
): MetricReader {
  const raw = new Decimal(opts.raw ?? 100);
  return {
    value: (expr) => {
      if (expr.kind !== 'market') return undefined;
      return raw;
    },
    // Then: the raw price was `splitFactorThen` times the split-adjusted one.
    valueAt: (expr) => {
      if (expr.kind !== 'market') return undefined;
      return expr.adjustment === 'none' ? raw.times(opts.splitFactorThen ?? 1) : raw;
    },
    fundamental: (_id, field) => latestObservation(list, field, AS_OF),
  };
}

const value = (metric: string, r: MetricReader) =>
  computeMetric({ metric, params: {} }, STOCK_A, r)?.toNumber();

describe('fundamental metrics (v1.2 item 6)', () => {
  const base = [
    obs('eps_ttm', '5'),
    obs('dps_ttm', '3.5'),
    obs('shares', '1000'),
    obs('equity', '25000'),
    obs('cash', '10000'),
    obs('debt', '30000'),
    obs('ebitda_ttm', '24000'),
  ];

  it('are all in the registry, for stocks, in their own category', () => {
    const ids = METRICS.filter((m) => m.category === 'fundamental').map((m) => m.id);
    expect(ids).toEqual([
      'pe',
      'earnings_yield',
      'dividend_yield',
      'price_to_book',
      'ev_ebitda',
      'dividend_streak',
      'revenue_ttm',
      'net_income_ttm',
      'eps_ttm',
    ]);
    for (const id of ids) expect(isFundamentalMetric(id)).toBe(true);
    expect(isFundamentalMetric('return')).toBe(false);
  });

  it('computes P/E, yields, price-to-book and EV/EBITDA from the latest filings', () => {
    const r = reader(base);
    expect(value('pe', r)).toBe(20);
    expect(value('earnings_yield', r)).toBe(0.05);
    expect(value('dividend_yield', r)).toBe(0.035);
    // Market cap 100 × 1,000 = 100,000 over equity 25,000.
    expect(value('price_to_book', r)).toBe(4);
    // EV = 100,000 + 30,000 − 10,000 = 120,000 over EBITDA 24,000.
    expect(value('ev_ebitda', r)).toBe(5);
  });

  it('gives no P/E for a loss, while earnings yield stays negative', () => {
    const r = reader([obs('eps_ttm', '-2')]);
    expect(value('pe', r)).toBeUndefined();
    expect(value('earnings_yield', r)).toBe(-0.02);
    expect(value('pe', reader([obs('eps_ttm', '0')]))).toBeUndefined();
  });

  it('is unknown before the first filing that supports it, never zero', () => {
    const later = [obs('eps_ttm', '5', '2025-06-03T12:00:00.000Z')];
    expect(value('pe', reader(later))).toBeUndefined();
    expect(value('dividend_yield', reader([obs('eps_ttm', '5')]))).toBeUndefined();
    expect(
      value('ev_ebitda', reader([obs('shares', '1000'), obs('ebitda_ttm', '1')])),
    ).toBeUndefined();
    expect(
      value('price_to_book', reader([obs('shares', '1000'), obs('equity', '-5')])),
    ).toBeUndefined();
  });

  it("puts a filing's per-share figures and share count on today's basis after a split", () => {
    // A 4-for-1 split since the filing: the raw price then was 4× the split-adjusted one.
    const r = reader(base, { splitFactorThen: 4 });
    expect(sharesPerOldShare(STOCK_A, AS_OF - 86_400_000, r, 0)?.toNumber()).toBe(4);
    // EPS 5 per old share is 1.25 per share today: P/E 100 / 1.25.
    expect(value('pe', r)).toBe(80);
    expect(value('eps_ttm', r)).toBe(1.25);
    // 1,000 old shares are 4,000 today.
    expect(value('price_to_book', r)).toBe(16);
  });

  it('formats dollar amounts', () => {
    expect(formatMetric({ metric: 'revenue_ttm', params: {} }, new Decimal(3.2e9))).toBe('$3.2B');
    expect(formatMetric({ metric: 'net_income_ttm', params: {} }, new Decimal(-4.5e6))).toBe(
      '−$4.5M',
    );
  });

  it('gives the screener the same values through fundamentalSnapshot', () => {
    expect(fundamentalSnapshot('dividend_yield', 100, base, AS_OF)?.toNumber()).toBe(0.035);
    expect(fundamentalSnapshot('pe', 100, base, AS_OF)?.toNumber()).toBe(20);
    expect(fundamentalSnapshot('pe', null, base, AS_OF)).toBeUndefined();
    expect(fundamentalSnapshot('pe', 100, undefined, AS_OF)).toBeUndefined();
  });
});

describe('strategies with fundamental metrics', () => {
  const def = validDefinition();
  def.entry.condition.children = [
    {
      kind: 'comparison',
      id: 'c1',
      operator: 'gt',
      left: {
        kind: 'metric',
        id: 'm1',
        metric: 'dividend_yield',
        params: {},
        instrumentId: STOCK_A,
      },
      right: { kind: 'constant', id: 'k1', value: '0.03' },
    },
  ];

  it('know which companies they read', () => {
    expect(usesFundamentals(def)).toBe(true);
    expect(fundamentalInstruments(def)).toEqual([STOCK_A]);
    expect(usesFundamentals(validDefinition())).toBe(false);
  });

  it('need a company data feed', () => {
    const codes = (hasCompanyFeed: boolean) =>
      validateStrategy(def, context({ hasCompanyFeed })).errors.map((e) => e.code);
    expect(codes(false)).toContain('missing_company_feed');
    expect(codes(true)).not.toContain('missing_company_feed');
  });
});
