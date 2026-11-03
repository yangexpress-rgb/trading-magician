import { describe, expect, it } from 'vitest';
import { CHART_RANGES, chartIntervalAllowed, chartWindow } from './chart';

describe('price chart windows', () => {
  it('ends on the New York date, even late in the UTC day', () => {
    // 2026-11-03 01:00 UTC is still 2 November in New York.
    expect(chartWindow('1m', new Date('2026-11-03T01:00:00Z'))).toEqual({
      from: '2026-10-02',
      to: '2026-11-02',
    });
    expect(chartWindow('1y', new Date('2026-11-03T15:00:00Z'))).toEqual({
      from: '2025-11-02',
      to: '2026-11-03',
    });
  });

  it('covers longer spans for longer ranges', () => {
    const now = new Date('2026-11-03T15:00:00Z');
    const starts = CHART_RANGES.map((r) => chartWindow(r, now).from);
    expect([...starts].sort().reverse()).toEqual(starts);
    expect(chartWindow('5y', now).from).toBe('2021-11-02');
  });

  it('offers hourly bars only up to 3 months', () => {
    expect(chartIntervalAllowed('3m', '1h')).toBe(true);
    expect(chartIntervalAllowed('6m', '1h')).toBe(false);
    expect(chartIntervalAllowed('5y', '1d')).toBe(true);
  });
});
