import { describe, expect, it } from 'vitest';
import {
  describeChart,
  formatChange,
  niceTicks,
  summarize,
  timeTickIndexes,
  toBars,
} from './research-text';

const bars = toBars([
  [Date.parse('2026-10-01T13:30:00Z'), 100, 104, 99, 103, 1000],
  [Date.parse('2026-10-02T13:30:00Z'), 103, 106, 101, 102, 1500],
  [Date.parse('2026-10-05T13:30:00Z'), 102, 111, 102, 110, 2500],
]);

describe('research chart text', () => {
  it('summarizes change from the first open to the last close', () => {
    expect(summarize(bars)).toMatchObject({
      first: 100,
      last: 110,
      change: 10,
      changePct: 10,
      high: 111,
      low: 99,
    });
    expect(summarize([])).toBeNull();
  });

  it('picks round axis values that cover the data', () => {
    const ticks = niceTicks(99, 111, 5);
    expect(ticks[0]).toBeLessThanOrEqual(99);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(111);
    expect(ticks).toEqual([97.5, 100, 102.5, 105, 107.5, 110, 112.5]);
    expect(niceTicks(50, 50).length).toBeGreaterThan(1);
  });

  it('spreads time labels across the bars, first and last included', () => {
    expect(timeTickIndexes(3)).toEqual([0, 1, 2]);
    expect(timeTickIndexes(251, 6)).toEqual([0, 50, 100, 150, 200, 250]);
  });

  it('writes the change with its sign and a sentence for screen readers', () => {
    expect(formatChange(10, 10)).toBe('+$10.00 (+10%)');
    expect(formatChange(-2.5, -1.25)).toBe('−$2.50 (−1.25%)');
    expect(describeChart('DEMO-A', bars, '1m', '1d')).toBe(
      'DEMO-A, daily prices over 1 month: up $10.00 (+10%), last $110.00, high $111.00, low $99.00, 3 bars.',
    );
    // Scrolled or zoomed: the bars' own dates (N195).
    expect(describeChart('DEMO-A', bars, '1m', '1d', true)).toMatch(
      /^DEMO-A, daily prices from \w{3} \d+, \d{4} to \w{3} \d+, \d{4}: up/,
    );
  });
});
