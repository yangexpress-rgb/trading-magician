import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { equityLimits, type EquityLimitsInput } from './equity-limits';

const d = (v: Decimal.Value) => new Decimal(v);

// $100k paper capital; bought 200 A at $100, so cash is -$20,000.
const base = (over: Partial<EquityLimitsInput> = {}): EquityLimitsInput => ({
  startingCapital: '100000',
  cash: d(-20000),
  positions: new Map([['A', d(200)]]),
  marks: new Map([['A', d(100)]]),
  today: '2026-11-09',
  day: { date: '2026-11-09', startEquity: '100000' },
  peakEquity: '100000',
  dailyLossLimit: '1000',
  maxDrawdownPct: '5',
  ...over,
});

describe('equityLimits', () => {
  it('marks holdings and judges the limits', () => {
    const r = equityLimits(base({ marks: new Map([['A', d(94)]]) }));
    expect(r.complete).toBe(true);
    expect(r.equity.toString()).toBe('98800');
    expect(r.gross.toString()).toBe('18800');
    expect(r.dailyLossHit).toBe(true);
    expect(r.drawdownHit).toBe(false);
  });

  it('a missing mark is not a loss of the whole holding (review M1)', () => {
    const r = equityLimits(base({ marks: new Map([['A', undefined]]) }));
    expect(r.complete).toBe(false);
    expect(r.dailyLossHit).toBe(false);
    expect(r.drawdownHit).toBe(false);
  });

  it('does not record the day or the peak from incomplete marks', () => {
    const r = equityLimits(
      base({
        today: '2026-11-10',
        marks: new Map([['A', undefined]]),
        peakEquity: '101000',
      }),
    );
    expect(r.day).toEqual({ date: '2026-11-09', startEquity: '100000' });
    expect(r.peakEquity).toBe('101000');
  });

  it('starts a new day from complete marks', () => {
    const r = equityLimits(base({ today: '2026-11-10', marks: new Map([['A', d(110)]]) }));
    expect(r.day).toEqual({ date: '2026-11-10', startEquity: '102000' });
    expect(r.peakEquity).toBe('102000');
    expect(r.dailyLossHit).toBe(false);
  });

  it('ignores flat positions and judges drawdown from the peak', () => {
    const r = equityLimits(
      base({
        positions: new Map([
          ['A', d(200)],
          ['B', d(0)],
        ]),
        marks: new Map([['A', d(70)]]),
        dailyLossLimit: undefined,
      }),
    );
    expect(r.complete).toBe(true);
    expect(r.equity.toString()).toBe('94000');
    expect(r.dailyLossHit).toBe(false);
    expect(r.drawdownHit).toBe(true);
  });
});
