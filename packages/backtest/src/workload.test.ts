import { describe, expect, it } from 'vitest';
import type { SeriesPlan } from './data';
import { estimateWorkload, MAX_BACKTEST_BARS, workloadProblem } from './workload';

const plan = (instrumentId: string, interval: string, from: string, to: string): SeriesPlan =>
  ({
    spec: { instrumentId, interval, adjustment: 'split_and_dividend', session: 'regular' },
    from,
    to,
  }) as SeriesPlan;

/** The failed Earnings breakout runs: a daily run with a 5-minute Last/Low for every member. */
const earningsBreakout = (members: number, from: string) =>
  Array.from({ length: members }, (_, i) => [
    plan(`m${i}`, '1d', '2025-06-01', '2026-11-07'),
    plan(`m${i}`, '5m', from, '2026-11-07'),
  ]).flat();

describe('back test workload (ADR 0081)', () => {
  it('estimates bars per interval from trading days in each series range', () => {
    const w = estimateWorkload(earningsBreakout(2, '2025-11-08'));
    expect(w.series).toBe(4);
    expect(w.byInterval['5m']).toMatchObject({ series: 2, instruments: 2, from: '2025-11-08' });
    // 365 days ≈ 252 trading days × 78 five-minute bars, per member.
    expect(w.byInterval['5m']?.estimatedBars).toBe(2 * 252 * 78);
  });

  it('refuses the S&P 500 with a year of 5-minute bars, saying what drives the size', () => {
    expect(workloadProblem(earningsBreakout(502, '2025-11-08'))).toMatch(
      /^This back test needs about 10\.\d million price bars, mostly 5-minute bars for 502 instruments over about 12 months\. A back test can hold up to 1\.2 million\. Shorten the dates or test fewer stocks\.$/,
    );
  });

  it('lets through smaller versions of the same strategy', () => {
    expect(workloadProblem(earningsBreakout(25, '2025-11-08'))).toBeUndefined();
    expect(workloadProblem(earningsBreakout(502, '2026-10-08'))).toBeUndefined();
    const daily = Array.from({ length: 502 }, (_, i) =>
      plan(`m${i}`, '1d', '2024-11-01', '2026-11-07'),
    );
    expect(workloadProblem(daily)).toBeUndefined();
  });

  it('uses the limit it is given', () => {
    const plans = earningsBreakout(1, '2025-11-08');
    expect(estimateWorkload(plans).estimatedBars).toBeLessThan(MAX_BACKTEST_BARS);
    expect(workloadProblem(plans, 1_000)).toMatch(/for 1 instrument over/);
  });
});
