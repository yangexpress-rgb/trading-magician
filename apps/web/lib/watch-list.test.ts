import { describe, expect, it } from 'vitest';
import {
  buildWatchList,
  changedFrom,
  formatWatchChange,
  formatWatchLast,
  formatWatchPct,
  nextWatchSort,
  parseWatchSort,
  shownWatchRow,
  sortWatchRows,
} from './watch-list';

describe('watch list text (N292)', () => {
  it('puts $ on stock prices and changes, never on an index', () => {
    expect(formatWatchLast(7332.83, false)).toBe('$7,332.83');
    expect(formatWatchLast(25.26, true)).toBe('25.26');
    expect(formatWatchLast(0.5123, false)).toBe('$0.5123');
    expect(formatWatchLast(null, false)).toBe('—');
    expect(formatWatchChange(-83.76, false)).toBe('−$83.76');
    expect(formatWatchChange(2.35, true)).toBe('+2.35');
    expect(formatWatchChange(0.001, false, 38.26)).toBe('$0.00');
  });

  it('signs percentages with a true minus', () => {
    expect(formatWatchPct(-1.1349)).toBe('−1.13%');
    expect(formatWatchPct(10.26)).toBe('+10.26%');
    expect(formatWatchPct(0)).toBe('0.00%');
    expect(formatWatchPct(-0.001)).toBe('0.00%');
  });

  it('finds the digits that moved', () => {
    expect(changedFrom('$351.95', '$351.97')).toBe(6);
    expect(changedFrom('$99.99', '$100.01')).toBe(1);
    expect(changedFrom('$5.00', '$5.00')).toBe(5);
  });

  it('joins each row to its price and works out the change', () => {
    const list = buildWatchList(
      [
        {
          id: 'g',
          name: 'Indices',
          collapsed: false,
          items: [
            { id: '1', symbol: 'VIX', instrumentId: null, displayName: null },
            { id: '2', symbol: 'SPY', instrumentId: null, displayName: 'S&P 500' },
          ],
        },
      ],
      [
        {
          symbol: 'VIX',
          last: 25.26,
          prevClose: 22.91,
          priceAt: '2026-11-16T21:15:00Z',
          daily: true,
        },
      ],
      new Date('2026-11-17T15:00:00Z'),
    );
    const [vix, spy] = list.groups[0]!.rows;
    expect(vix).toMatchObject({ isIndex: true, daily: true, displayName: 'CBOE Volatility Index' });
    expect(vix!.change).toBeCloseTo(2.35, 6);
    expect(vix!.changePct).toBeCloseTo(10.257, 2);
    expect(spy).toMatchObject({ isIndex: false, last: null, change: null });
  });
});

describe('watch list sorting (N293)', () => {
  const row = (symbol: string, changePct: number | null) =>
    ({ symbol, changePct, last: changePct, change: changePct }) as never;
  const rows = [row('B', 1), row('A', null), row('C', -2)];

  it('sorts ascending, descending, then back to the saved order', () => {
    let s = nextWatchSort(null, 'changePct');
    expect(sortWatchRows(rows, s).map((r) => r.symbol)).toEqual(['C', 'B', 'A']);
    s = nextWatchSort(s, 'changePct');
    expect(sortWatchRows(rows, s).map((r) => r.symbol)).toEqual(['B', 'C', 'A']);
    s = nextWatchSort(s, 'changePct');
    expect(s).toBeNull();
    expect(sortWatchRows(rows, s).map((r) => r.symbol)).toEqual(['B', 'A', 'C']);
    expect(sortWatchRows(rows, { key: 'symbol', dir: 'desc' }).map((r) => r.symbol)).toEqual([
      'C',
      'B',
      'A',
    ]);
  });

  it('remembers only a sort it knows', () => {
    expect(parseWatchSort('last.desc')).toEqual({ key: 'last', dir: 'desc' });
    expect(parseWatchSort('nope.asc')).toBeNull();
    expect(parseWatchSort(null)).toBeNull();
  });
});

describe('regular session and extended hours (N296)', () => {
  const group = {
    id: 'g',
    name: 'Stocks',
    collapsed: false,
    items: [
      { id: '1', symbol: 'AAPL', instrumentId: null, displayName: null },
      { id: '2', symbol: 'TSLA', instrumentId: null, displayName: null },
    ],
  };
  const quotes = [
    // Tuesday 2026-11-17: closed at 200 (from 196), traded 202 at 5 PM New York.
    {
      symbol: 'AAPL',
      last: 200,
      prevClose: 196,
      priceAt: '2026-11-17T21:00:00.000Z',
      daily: false,
      extLast: 202,
      extAt: '2026-11-17T22:00:00.000Z',
    },
    // Wednesday 8 AM New York, before the open.
    {
      symbol: 'TSLA',
      last: 100,
      prevClose: 100,
      priceAt: '2026-11-17T21:00:00.000Z',
      daily: false,
      extLast: 99,
      extAt: '2026-11-18T13:00:00.000Z',
    },
  ];
  const [aapl, tsla] = buildWatchList([group], quotes, new Date()).groups[0]!.rows;

  it('shows the regular session by default', () => {
    expect(shownWatchRow(aapl!, false)).toMatchObject({ last: 200, change: 4 });
    expect(aapl!.changePct).toBeCloseTo(2.0408, 3);
  });

  it('with Ext hours on, measures pre-market and after-hours trades from the regular close', () => {
    expect(aapl!.ext).toMatchObject({ phase: 'post', last: 202, change: 2, changePct: 1 });
    expect(shownWatchRow(aapl!, true)).toMatchObject({ last: 202, change: 2, changePct: 1 });
    expect(tsla!.ext).toMatchObject({ phase: 'pre', last: 99, change: -1, changePct: -1 });
  });
});
