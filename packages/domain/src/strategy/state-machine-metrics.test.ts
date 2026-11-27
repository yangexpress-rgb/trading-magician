import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { Bar } from '../market/bars';
import { indicatorSeries } from '../market/indicators';
import { ALL_HISTORY_BARS, getIndicator } from './catalog';
import { checkMetricRef, computeMetric, metricRequirements, type MetricReader } from './metrics';
import type { IndicatorExpr, MarketExpr } from './schema';

/**
 * The three metrics of the state-machine brief v1.3 §3 (N381–N383): each
 * against a plain recomputation, and A2, no lookahead: changing any bar after
 * bar t never changes the value at t.
 */

type Day = { close: number; volume: number };

/** A seeded random walk of `count` daily bars. */
function walk(count: number, seed = 11): Day[] {
  let x = seed;
  const rand = () => (x = (x * 16807) % 2147483647) / 2147483647;
  let close = 100;
  return Array.from({ length: count }, () => {
    close = Math.max(5, close * (1 + (rand() - 0.5) * 0.05));
    return {
      close: Math.round(close * 100) / 100,
      volume: Math.round(1_000_000 * (0.3 + rand() * 1.7)),
    };
  });
}

function toBars(days: Day[]): Bar[] {
  return days.map((d, i) => {
    const c = new Decimal(d.close);
    return {
      start: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString(),
      end: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000 + 23_400_000).toISOString(),
      open: c,
      high: c,
      low: c,
      close: c,
      volume: new Decimal(d.volume),
    } as unknown as Bar;
  });
}

/** Reads bars as the engines do: `offset + barsBack` bars before the newest loaded one. */
function reader(days: Day[], last = days.length - 1): MetricReader {
  const bars = toBars(days);
  const cache = new Map<string, (Decimal | undefined)[]>();
  return {
    value(expr: MarketExpr | IndicatorExpr, barsBack: number) {
      const at = last - expr.offset - barsBack;
      if (at < 0) return undefined;
      if (expr.kind === 'market') {
        const b = bars[at] as unknown as Record<string, Decimal>;
        return b[expr.field];
      }
      const key = `${expr.name}|${JSON.stringify(expr.params)}|${expr.field}`;
      if (!cache.has(key))
        cache.set(key, indicatorSeries(expr.name, expr.params, bars, expr.field));
      return cache.get(key)?.[at];
    },
  };
}

const m = (metric: string, params: Record<string, number>, days: Day[], last = days.length - 1) =>
  computeMetric({ metric, params }, 'X', reader(days, last))?.toNumber();

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const smaAt = (closes: number[], i: number, n: number) =>
  i < n - 1 ? undefined : mean(closes.slice(i - n + 1, i + 1));

describe('ma_slope (N381)', () => {
  const days = walk(300);
  const closes = days.map((d) => d.close);

  it('is SMA(period) now over SMA(period) bars back, minus 1', () => {
    for (const [period, bars] of [
      [20, 1],
      [50, 5],
      [200, 1],
    ] as const) {
      for (const t of [250, 280, 299]) {
        const now = smaAt(closes, t, period)!;
        const before = smaAt(closes, t - bars, period)!;
        expect(m('ma_slope', { period, bars }, days, t)).toBeCloseTo(now / before - 1, 10);
      }
    }
  });

  it('defaults to MA20 against the bar before', () => {
    const t = 299;
    const want = smaAt(closes, t, 20)! / smaAt(closes, t - 1, 20)! - 1;
    expect(m('ma_slope', {}, days)).toBeCloseTo(want, 10);
  });

  it('is null until both averages exist', () => {
    expect(m('ma_slope', { period: 20, bars: 1 }, days, 19)).toBeUndefined();
    expect(m('ma_slope', { period: 20, bars: 1 }, days, 20)).toBeDefined();
  });
});

describe('relative_volume (N382)', () => {
  const days = walk(200);
  const vols = days.map((d) => d.volume);

  it('divides the day by the mean of the window before it, the day left out', () => {
    for (const window of [20, 60]) {
      for (const t of [100, 150, 199]) {
        const want = (vols[t] as number) / mean(vols.slice(t - window, t));
        expect(m('relative_volume', { window }, days, t)).toBeCloseTo(want, 10);
      }
    }
  });

  it('is null without a full window before the day', () => {
    expect(m('relative_volume', { window: 60 }, days, 59)).toBeUndefined();
    expect(m('relative_volume', { window: 60 }, days, 60)).toBeDefined();
  });

  it('is not offered for indices, which have no volume', async () => {
    const { getMetric } = await import('./metrics');
    expect(getMetric('relative_volume')?.assetClasses).not.toContain('index');
  });
});

describe('ath_drawdown (N383)', () => {
  const days = walk(400);
  const closes = days.map((d) => d.close);

  it('with window 0 compares with the highest close of all loaded history', () => {
    for (const t of [0, 1, 50, 399]) {
      const high = Math.max(...closes.slice(0, t + 1));
      expect(m('ath_drawdown', {}, days, t)).toBeCloseTo((closes[t] as number) / high - 1, 10);
    }
  });

  it('with a window compares with the highest close of the last window bars', () => {
    for (const t of [251, 399]) {
      const high = Math.max(...closes.slice(t - 251, t + 1));
      expect(m('ath_drawdown', { window: 252 }, days, t)).toBeCloseTo(
        (closes[t] as number) / high - 1,
        10,
      );
    }
    expect(m('ath_drawdown', { window: 252 }, days, 250)).toBeUndefined();
  });

  it('reads 0 on a new high and never above it', () => {
    const rising = closes.map((_, i) => ({ close: 100 + i, volume: 1 }));
    expect(m('ath_drawdown', {}, rising)).toBe(0);
    for (let t = 0; t < days.length; t += 7)
      expect(m('ath_drawdown', {}, days, t)).toBeLessThanOrEqual(0);
  });

  it('asks for all history when the window is 0, so runs load from the data start', () => {
    const [high] = metricRequirements({ metric: 'ath_drawdown', params: {} }, 'X') as [
      IndicatorExpr,
    ];
    expect(high.name).toBe('HIGHEST_EVER');
    expect(getIndicator('HIGHEST_EVER')?.lookback({})).toBe(ALL_HISTORY_BARS);
    const [windowed] = metricRequirements(
      { metric: 'ath_drawdown', params: { window: 252 } },
      'X',
    ) as [IndicatorExpr];
    expect(windowed).toMatchObject({ name: 'HIGHEST', params: { period: 252 } });
  });

  it('refuses a window past 20 years or below 0', () => {
    expect(checkMetricRef({ metric: 'ath_drawdown', params: { window: -1 } })).not.toEqual([]);
    expect(
      checkMetricRef({ metric: 'ath_drawdown', params: { window: ALL_HISTORY_BARS + 1 } }),
    ).not.toEqual([]);
    expect(checkMetricRef({ metric: 'ath_drawdown', params: { window: 0 } })).toEqual([]);
  });
});

describe('A2: no lookahead in the new metrics', () => {
  const cases: [string, Record<string, number>][] = [
    ['ma_slope', { period: 20, bars: 1 }],
    ['ma_slope', { period: 50, bars: 10 }],
    ['relative_volume', { window: 60 }],
    ['ath_drawdown', {}],
    ['ath_drawdown', { window: 120 }],
  ];

  it('changing any bar after t never changes the value at t', () => {
    const base = walk(260, 3);
    for (const [metric, params] of cases) {
      for (const t of [150, 200, 230]) {
        const before = m(metric, params, base, t);
        expect(before).toBeDefined();
        for (const seed of [5, 17, 29]) {
          // Every bar after t replaced, including a new all-time high and a volume spike.
          const future = walk(base.length - t - 1, seed).map((d, i) => ({
            close: i === 0 ? 10_000 : d.close * 3,
            volume: d.volume * 50,
          }));
          const mutated = [...base.slice(0, t + 1), ...future];
          expect(m(metric, params, mutated, t)).toBe(before);
        }
      }
    }
  });
});
