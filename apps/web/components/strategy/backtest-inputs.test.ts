import { describe, expect, it } from 'vitest';
import { parseSymbols, runDates } from './backtest';

describe('back test inputs (N229, N230)', () => {
  it('reads typed symbols once each, upper case', () => {
    expect(parseSymbols(' aapl, MSFT  nvda;aapl ')).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(parseSymbols('')).toEqual([]);
  });

  it("ends a run that ends today at yesterday's close", () => {
    expect(runDates('2026-11-11', '1m', '2026-11-11')).toEqual({
      from: '2026-10-11',
      to: '2026-11-10',
      endsToday: true,
    });
    expect(runDates('2026-06-30', '6m', '2026-11-11')).toEqual({
      from: '2025-12-30',
      to: '2026-06-30',
      endsToday: false,
    });
  });
});
