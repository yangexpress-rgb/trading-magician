import { describe, expect, it } from 'vitest';
import {
  buildWatchList,
  changedFrom,
  formatWatchChange,
  formatWatchLast,
  formatWatchPct,
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
