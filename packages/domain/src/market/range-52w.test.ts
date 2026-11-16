import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { addDays, isTradingDay, nextTradingDay } from './calendar';
import type { Bar } from './bars';
import { barsSinceExtreme, indicatorSeries } from './indicators';
import { liveYearRange, yearRange, type RangeDay } from './range-52w';
import { computeMetric, type MetricReader } from '../strategy/metrics';
import type { IndicatorExpr, MarketExpr } from '../strategy/schema';

/** A seeded walk of daily sessions, oldest first, ending on `last`. */
function sessions(count: number, last = '2026-11-13', seed = 7): RangeDay[] {
  const dates: string[] = [];
  for (let d = last; dates.length < count; d = addDays(d, -1)) if (isTradingDay(d)) dates.push(d);
  dates.reverse();
  let x = seed;
  const rand = () => (x = (x * 16807) % 2147483647) / 2147483647;
  let close = 100;
  return dates.map((date) => {
    close = Math.max(5, close * (1 + (rand() - 0.5) * 0.06));
    const low = Math.round(close * (1 - rand() * 0.03) * 100) / 100;
    const high = Math.round(close * (1 + rand() * 0.03) * 100) / 100;
    return { date, low, high, close: Math.round(close * 100) / 100 };
  });
}

function naiveAgo(xs: number[], n: number, pick: 'min' | 'max') {
  return xs.map((_, i) => {
    if (i < n - 1) return undefined;
    let at = i;
    for (let k = i; k > i - n; k--) {
      const v = xs[k] as number;
      const best = xs[at] as number;
      if (pick === 'min' ? v < best : v > best) at = k;
    }
    return i - at;
  });
}

describe('bars since the extreme (N290)', () => {
  it('matches a plain scan, ties to the latest bar', () => {
    const xs = [5, 3, 3, 7, 2, 2, 9, 9, 1, 4, 4, 6, 1, 8];
    for (const n of [1, 3, 5]) {
      for (const pick of ['min', 'max'] as const) {
        const got = barsSinceExtreme(
          xs.map((v) => new Decimal(v)),
          n,
          pick,
        ).map((v) => v?.toNumber());
        expect(got).toEqual(naiveAgo(xs, n, pick));
      }
    }
  });

  it('matches over a year of random sessions', () => {
    const days = sessions(400);
    const lows = days.map((d) => d.low);
    const got = barsSinceExtreme(
      lows.map((v) => new Decimal(v)),
      252,
      'min',
    ).map((v) => v?.toNumber());
    expect(got).toEqual(naiveAgo(lows, 252, 'min'));
  });
});

describe('52-week low and high (N290)', () => {
  it('needs a full 252 sessions', () => {
    expect(yearRange(sessions(251))).toBeUndefined();
    expect(yearRange(sessions(252))).toBeDefined();
  });

  it('finds the low and high and counts trading days since each', () => {
    const days = sessions(300);
    const window = days.slice(-252);
    const r = yearRange(days)!;
    const low = Math.min(...window.map((d) => d.low));
    const high = Math.max(...window.map((d) => d.high));
    expect(r.asOf).toBe('2026-11-13');
    expect(r.low.price).toBe(low);
    expect(r.high.price).toBe(high);
    const lowAt = window.map((d) => d.low).lastIndexOf(low);
    expect(r.low.on).toBe(window[lowAt]?.date);
    expect(r.low.days).toBe(251 - lowAt);
    expect(r.tailLow.price).toBe(Math.min(...window.slice(1).map((d) => d.low)));
  });

  it('counts 0 days when the last session set the low', () => {
    const days = sessions(260);
    days[days.length - 1] = { ...days.at(-1)!, low: 1, close: 1.5 };
    const r = yearRange(days)!;
    expect(r.low).toEqual({ price: 1, on: '2026-11-13', days: 0 });
  });

  it('rolls forward a session with today’s prices', () => {
    const days = sessions(300);
    const stored = yearRange(days)!;
    const today = nextTradingDay(stored.asOf);
    // A quiet day: the low comes from the latest 251 sessions, a day further back.
    const quiet = liveYearRange(stored, {
      date: today,
      low: stored.tailLow.price + 1,
      high: stored.tailHigh.price - 1,
      last: 50,
    });
    expect(quiet.asOf).toBe(today);
    expect(quiet.low).toEqual({ ...stored.tailLow, days: stored.tailLow.days + 1 });
    expect(quiet.price).toBe(50);
    // The same as working it out from scratch with today's session added.
    const fresh = yearRange([
      ...days,
      { date: today, low: stored.tailLow.price + 1, high: stored.tailHigh.price - 1, close: 50 },
    ])!;
    expect(quiet.low).toEqual(fresh.low);
    expect(quiet.high).toEqual(fresh.high);
    // A new low today.
    const newLow = liveYearRange(stored, { date: today, low: 0.5, high: 1, last: 0.75 });
    expect(newLow.low).toEqual({ price: 0.5, on: today, days: 0 });
    expect(newLow.fromLowPct).toBe(50);
  });

  it('keeps stored figures that are more than a session old', () => {
    const stored = yearRange(sessions(300))!;
    const later = nextTradingDay(nextTradingDay(stored.asOf));
    const v = liveYearRange(stored, { date: later, low: 0.5, high: 1, last: 0.75 });
    expect(v.asOf).toBe(stored.asOf);
    expect(v.low).toEqual(stored.low);
    expect(v.price).toBe(stored.close);
  });

  it('agrees with the strategy metrics', () => {
    const days = sessions(300);
    const bars: Bar[] = days.map((d) => ({
      start: `${d.date}T14:30:00Z`,
      end: `${d.date}T21:00:00Z`,
      open: new Decimal(d.close),
      high: new Decimal(d.high),
      low: new Decimal(d.low),
      close: new Decimal(d.close),
      volume: new Decimal(1000),
    }));
    const cache = new Map<string, (Decimal | undefined)[]>();
    const reader: MetricReader = {
      value(expr: MarketExpr | IndicatorExpr, barsBack: number) {
        const at = bars.length - 1 - expr.offset - barsBack;
        if (at < 0) return undefined;
        if (expr.kind === 'market') return bars[at]?.[expr.field as 'close' | 'low' | 'high'];
        const key = `${expr.name}|${expr.field}`;
        if (!cache.has(key))
          cache.set(key, indicatorSeries(expr.name, expr.params, bars, expr.field));
        return cache.get(key)?.[at];
      },
    };
    const r = yearRange(days)!;
    const m = (metric: string) => computeMetric({ metric, params: {} }, 'X', reader)?.toNumber();
    expect(m('days_since_52w_low')).toBe(r.low.days);
    expect(m('days_since_52w_high')).toBe(r.high.days);
    expect(m('from_52w_low')).toBeCloseTo(r.close / r.low.price - 1, 10);
    expect(m('from_52w_high')).toBeCloseTo(r.close / r.high.price - 1, 10);
  });
});
