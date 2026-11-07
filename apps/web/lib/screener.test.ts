import { SP500_SECTORS, type ScreenRow } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import {
  COLUMN_BY_KEY,
  decodeScreenState,
  encodeScreenState,
  EMPTY_FILTERS,
  filterRows,
  formatCell,
  hasOptionFigures,
  parseAmount,
  screenPresets,
  sectorOf,
  sortRows,
  toCsv,
} from './screener';

function row(symbol: string, values: Partial<ScreenRow> = {}): ScreenRow {
  return {
    symbol,
    name: `${symbol} Holdings Inc.`,
    assetClass: 'stock',
    exchange: 'NASDAQ',
    last: 10,
    change: 0,
    changePct: 0,
    open: 10,
    high: 10,
    low: 10,
    volume: 1000,
    dollarVolume: 10_000,
    prevClose: 10,
    prevChangePct: 0,
    gapPct: 0,
    rangePct: 0,
    change5dPct: 0,
    change1mPct: 0,
    high1m: 10,
    low1m: 10,
    fromHigh1mPct: 0,
    fromLow1mPct: 0,
    marketCap: null,
    pe: null,
    revenue: null,
    revenueGrowthPct: null,
    netIncome: null,
    netMarginPct: null,
    eps: null,
    dividendYieldPct: null,
    priceToBook: null,
    evEbitda: null,
    iv30Pct: null,
    ivRank: null,
    expectedMove1wPct: null,
    ivRvRatio: null,
    skewPts: null,
    termStructure: null,
    putCallOi: null,
    avgVolume20: 1000,
    relVolume: 1,
    lastAt: null,
    instrumentId: null,
    ...values,
  };
}

const rows = [
  row('AAA', { changePct: 5, volume: 2_000_000 }),
  row('BBB', { changePct: -3, name: 'Bank of Things', assetClass: 'etf', exchange: 'ARCA' }),
  row('CCC', { changePct: null, volume: null }),
  row('ABC', { changePct: 1 }),
];

describe('screener filters', () => {
  it('reads amounts with k, M and B, commas and percent signs', () => {
    expect(parseAmount('1.5M')).toBe(1_500_000);
    expect(parseAmount('250k')).toBe(250_000);
    expect(parseAmount('2b')).toBe(2_000_000_000);
    expect(parseAmount('1,000')).toBe(1000);
    expect(parseAmount('-3.5%')).toBe(-3.5);
    expect(parseAmount('+2')).toBe(2);
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount('abc')).toBeUndefined();
  });

  it('keeps rows inside every range, leaving out rows without the value', () => {
    const picked = filterRows(rows, { ...EMPTY_FILTERS, ranges: { changePct: { min: 0 } } });
    expect(picked.map((r) => r.symbol)).toEqual(['AAA', 'ABC']);
    const both = filterRows(rows, {
      ...EMPTY_FILTERS,
      ranges: { changePct: { min: 0, max: 2 } },
    });
    expect(both.map((r) => r.symbol)).toEqual(['ABC']);
  });

  it('matches symbols by their start and names by any word', () => {
    expect(filterRows(rows, { ...EMPTY_FILTERS, text: 'a' }).map((r) => r.symbol)).toEqual([
      'AAA',
      'ABC',
    ]);
    expect(filterRows(rows, { ...EMPTY_FILTERS, text: 'bank' }).map((r) => r.symbol)).toEqual([
      'BBB',
    ]);
    expect(filterRows(rows, { ...EMPTY_FILTERS, type: 'etf' })).toHaveLength(1);
    expect(filterRows(rows, { ...EMPTY_FILTERS, exchange: 'NASDAQ' })).toHaveLength(3);
  });
});

describe('the S&P 500 universe', () => {
  const market = [row('AAPL'), row('JPM'), row('ZZZQ'), row('SPY', { assetClass: 'etf' })];

  it('keeps members only, and knows their sectors', () => {
    const members = filterRows(market, EMPTY_FILTERS, 'sp500').map((r) => r.symbol);
    expect(members).toEqual(['AAPL', 'JPM']);
    expect(filterRows(market, EMPTY_FILTERS, 'all')).toHaveLength(4);
    expect(sectorOf({ symbol: 'JPM' })).toBe('Financials');
    expect(sectorOf({ symbol: 'ZZZQ' })).toBeNull();
    const banks = filterRows(market, { ...EMPTY_FILTERS, sector: 'Financials' }, 'all');
    expect(banks.map((r) => r.symbol)).toEqual(['JPM']);
  });

  it('sorts by sector with non-members last', () => {
    const sorted = sortRows(market, { key: 'sector', dir: 'asc' }).map((r) => r.symbol);
    expect(sorted).toEqual(['JPM', 'AAPL', 'SPY', 'ZZZQ']);
  });

  it('ships a full member list', () => {
    expect(SP500_SECTORS.size).toBeGreaterThan(490);
    expect(SP500_SECTORS.has('BRK.B')).toBe(true);
  });
});

describe('screener sorting', () => {
  it('sorts either way, with missing values last', () => {
    const down = sortRows(rows, { key: 'changePct', dir: 'desc' }).map((r) => r.symbol);
    expect(down).toEqual(['AAA', 'ABC', 'BBB', 'CCC']);
    const up = sortRows(rows, { key: 'changePct', dir: 'asc' }).map((r) => r.symbol);
    expect(up).toEqual(['BBB', 'ABC', 'AAA', 'CCC']);
    expect(sortRows(rows, { key: 'symbol', dir: 'asc' }).map((r) => r.symbol)).toEqual([
      'AAA',
      'ABC',
      'BBB',
      'CCC',
    ]);
  });

  it('offers presets that use real columns', () => {
    for (const p of screenPresets(true)) {
      for (const key of Object.keys(p.filters.ranges)) {
        expect(COLUMN_BY_KEY.has(key as never)).toBe(true);
      }
    }
  });
});

describe('screener formatting and export', () => {
  it('writes signs, units and blanks', () => {
    expect(formatCell(2.5, 'pct')).toBe('+2.50%');
    expect(formatCell(-1, 'pct')).toBe('−1.00%');
    expect(formatCell(1_500_000, 'volume')).toBe('1.5M');
    expect(formatCell(2_000_000_000, 'money')).toBe('$2B');
    expect(formatCell(1.234, 'ratio')).toBe('1.23×');
    expect(formatCell(0.1234, 'price')).toBe('0.1234');
    expect(formatCell(null, 'price')).toBe('—');
  });

  it('exports CSV with quoted names', () => {
    const csv = toCsv([row('AAA', { name: 'Alpha, Inc.' })], [COLUMN_BY_KEY.get('last')!]);
    expect(csv).toBe(
      'Symbol,Name,Type,Exchange,Sector,Last price\nAAA,"Alpha, Inc.",stock,NASDAQ,,10',
    );
  });

  it('keeps filters and sorting in the address', () => {
    const q = encodeScreenState(
      {
        text: 'bank',
        type: 'etf',
        exchange: 'ARCA',
        sector: 'Financials',
        ranges: { changePct: { min: 2 }, volume: { max: 1e6 } },
      },
      { key: 'changePct', dir: 'asc' },
      ['last', 'changePct'],
      'all',
      'sp500',
    );
    expect(q.get('universe')).toBe('all');
    const back = decodeScreenState(new URLSearchParams(q.toString()), 'sp500');
    expect(back.universe).toBe('all');
    expect(back.sort).toEqual({ key: 'changePct', dir: 'asc' });
    expect(back.filters).toEqual({
      text: 'bank',
      type: 'etf',
      exchange: 'ARCA',
      sector: 'Financials',
      ranges: { changePct: { min: 2, max: undefined }, volume: { min: undefined, max: 1e6 } },
    });
    expect(back.columns).toEqual(['last', 'changePct']);
    // Anything unknown falls back to the defaults.
    const junk = decodeScreenState(
      new URLSearchParams('sort=nope.up&f=evil:1:2&type=bond&sector=Nope'),
      'sp500',
    );
    expect(junk.universe).toBe('sp500');
    expect(junk.filters.sector).toBe('');
    expect(junk.sort.key).toBe('dollarVolume');
    expect(junk.filters.ranges).toEqual({});
    expect(junk.filters.type).toBe('all');
  });
});

describe('options columns', () => {
  it('stay hidden until a row has options figures, and filter like any column', () => {
    expect(hasOptionFigures(rows)).toBe(false);
    const withOptions = [row('SPY', { iv30Pct: 14.2, ivRank: 30 }), row('QQQ', { iv30Pct: 19.8 })];
    expect(hasOptionFigures(withOptions)).toBe(true);
    expect(COLUMN_BY_KEY.get('iv30Pct')?.hint).toMatch(/daily options recording/);
    expect(COLUMN_BY_KEY.get('iv30Pct')?.hint).not.toMatch(/0\.20 is 20%/);
  });
});
