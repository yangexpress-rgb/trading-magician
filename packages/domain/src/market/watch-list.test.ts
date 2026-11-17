import { describe, expect, it } from 'vitest';
import {
  normalizeWatchGroupName,
  normalizeWatchSymbol,
  WATCH_LIST_DEFAULTS,
  WATCH_REFRESH,
  watchChange,
  watchRefreshMs,
} from './watch-list';

describe('watch list (N292)', () => {
  it('takes tickers in any case and refuses anything else', () => {
    expect(normalizeWatchSymbol(' aapl ')).toBe('AAPL');
    expect(normalizeWatchSymbol('brk.b')).toBe('BRK.B');
    expect(normalizeWatchSymbol('1ABC')).toBeUndefined();
    expect(normalizeWatchSymbol('')).toBeUndefined();
    expect(normalizeWatchSymbol('ABCDEFGHIJK')).toBeUndefined();
  });

  it('trims group names and keeps them short', () => {
    expect(normalizeWatchGroupName('  My   tech ')).toBe('My tech');
    expect(normalizeWatchGroupName('   ')).toBeUndefined();
    expect(normalizeWatchGroupName('x'.repeat(41))).toBeUndefined();
  });

  it('measures the change from the previous close', () => {
    const c = watchChange({ last: 351.95, prevClose: 352.78 });
    expect(c?.change).toBeCloseTo(-0.83, 6);
    expect(c?.changePct).toBeCloseTo(-0.2353, 3);
    expect(watchChange({ last: 10, prevClose: null })).toBeNull();
  });

  it('starts with indices and stocks, every symbol valid', () => {
    expect(WATCH_LIST_DEFAULTS.map((g) => g.name)).toEqual(['Indices', 'Stocks']);
    for (const g of WATCH_LIST_DEFAULTS)
      for (const i of g.items) expect(normalizeWatchSymbol(i.symbol)).toBe(i.symbol);
  });

  it('refreshes every few seconds while stocks trade, once a minute otherwise', () => {
    // Tuesday 2026-11-17: 10:00 New York (15:00Z), 19:00 (00:00Z next day), 21:00.
    expect(watchRefreshMs(new Date('2026-11-17T15:00:00Z'))).toBe(WATCH_REFRESH.activeMs);
    expect(watchRefreshMs(new Date('2026-11-17T09:30:00Z'))).toBe(WATCH_REFRESH.activeMs);
    expect(watchRefreshMs(new Date('2026-11-18T00:30:00Z'))).toBe(WATCH_REFRESH.activeMs);
    expect(watchRefreshMs(new Date('2026-11-18T02:00:00Z'))).toBe(WATCH_REFRESH.quietMs);
    // Saturday.
    expect(watchRefreshMs(new Date('2026-11-21T15:00:00Z'))).toBe(WATCH_REFRESH.quietMs);
  });
});
