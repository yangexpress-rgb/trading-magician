import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { addDays, regularSession } from '../market/calendar';
import {
  checkMetricRef,
  computeMetric,
  isRankingMetric,
  type MetricReader,
} from '../strategy/metrics';
import {
  FEATURE_NAMES_V1,
  featureAvailability,
  isComplete,
  percentile,
  predictionDates,
  tradingDayAfter,
  transformCrossSection,
  winsorisedZScores,
} from './features';
import {
  ML_SCORE_MAX_AGE_DAYS,
  mlProvenance,
  predictionAt,
  predictionAvailableFrom,
  type MlPrediction,
} from './predictions';

const p = (asOf: string, score = 0.5, runNo = 1): MlPrediction => ({
  asOf,
  score,
  runNo,
  trainingEnd: '2026-07-31',
});
/** An instant on a calendar day, after any close. */
const evening = (date: string) => Date.parse(`${date}T23:00:00Z`);

describe('predictionAt: staleness fixture (ML brief v1 §12 check 4)', () => {
  const list = [p('2026-09-30', 0.83, 14)];

  it('reads a prediction 45 calendar days old', () => {
    const at = addDays('2026-09-30', ML_SCORE_MAX_AGE_DAYS);
    expect(predictionAt(list, evening(at))?.score).toBe(0.83);
  });

  it('reads a prediction 46 calendar days old as unknown', () => {
    const at = addDays('2026-09-30', ML_SCORE_MAX_AGE_DAYS + 1);
    expect(predictionAt(list, evening(at))).toBeUndefined();
  });

  it("is not visible before its own date's close", () => {
    const close = predictionAvailableFrom('2026-09-30');
    expect(close).toBe(Date.parse(regularSession('2026-09-30')?.close ?? ''));
    expect(predictionAt(list, close - 1)).toBeUndefined();
    expect(predictionAt(list, close)?.score).toBe(0.83);
  });

  it('takes the latest dated on or before the bar', () => {
    const two = [p('2026-08-31', 0.1, 13), p('2026-09-30', 0.2, 14)];
    expect(predictionAt(two, evening('2026-09-29'))?.runNo).toBe(13);
    expect(predictionAt(two, evening('2026-10-15'))?.runNo).toBe(14);
  });

  it('writes the provenance line of brief §10', () => {
    expect(
      mlProvenance('mf-ranker-ridge', { ...p('2026-09-30', 0.83, 14), trainingEnd: '2026-08-29' }),
    ).toBe(
      'ML score 0.83 — model mf-ranker-ridge, run 14, trained through Aug 29, 2026, score dated Sep 30, 2026',
    );
  });
});

describe('the ml.score metric (brief §8)', () => {
  const reader = (score?: number): MetricReader => ({
    value: () => undefined,
    ml: (_id, key) =>
      score === undefined
        ? undefined
        : { value: new Decimal(score), modelKey: key, prediction: p('2026-09-30', score) },
  });

  it('ranks, and needs a model series key', () => {
    expect(isRankingMetric('ml.score')).toBe(true);
    expect(checkMetricRef({ metric: 'ml.score', params: { modelKey: 'mf-ranker-ridge' } })).toEqual(
      [],
    );
    expect(checkMetricRef({ metric: 'ml.score', params: {} })).toEqual(['Choose the model series']);
    expect(checkMetricRef({ metric: 'ml.score', params: { modelKey: 'Not A Key' } })).toEqual([
      '"Not A Key" is not a model series key',
    ]);
  });

  it('reads the stored score, and unknown without one (never 0)', () => {
    const ref = { metric: 'ml.score', params: { modelKey: 'mf-ranker-ridge' } };
    expect(computeMetric(ref, 'x', reader(0.83))?.toNumber()).toBe(0.83);
    expect(computeMetric(ref, 'x', reader())).toBeUndefined();
  });
});

describe('cross-sectional transform (brief §6)', () => {
  it('interpolates percentiles as numpy does', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([0, 10], 0.99)).toBeCloseTo(9.9, 12);
  });

  it('winsorises at the 1st/99th percentile, then z-scores with the sample SD', () => {
    const xs = [...Array.from({ length: 99 }, (_, i) => i), 10_000];
    const z = winsorisedZScores(xs) as number[];
    const sorted = [...xs].sort((a, b) => a - b);
    const hi = percentile(sorted, 0.99);
    const lo = percentile(sorted, 0.01);
    const clipped = xs.map((x) => Math.min(hi, Math.max(lo, x)));
    const mean = clipped.reduce((a, x) => a + x, 0) / clipped.length;
    const sd = Math.sqrt(clipped.reduce((a, x) => a + (x - mean) ** 2, 0) / (clipped.length - 1));
    expect(z[99]).toBeCloseTo((hi - mean) / sd, 12);
    expect(z[0]).toBeCloseTo((lo - mean) / sd, 12);
    // Unclipped, the outlier would sit near 9.9 SDs out.
    expect(z[99]).toBeLessThan(5);
  });

  it('keeps nulls null and never zero-fills', () => {
    expect(winsorisedZScores([1, null, 3])).toEqual([-Math.SQRT1_2, null, Math.SQRT1_2]);
    expect(winsorisedZScores([1, null])).toEqual([null, null]);
    expect(winsorisedZScores([2, 2, 2])).toEqual([null, null, null]);
  });

  it('gives a member with any null feature no prediction', () => {
    const full = Object.fromEntries(FEATURE_NAMES_V1.map((n) => [n, 1]));
    expect(isComplete(full)).toBe(true);
    expect(isComplete({ ...full, pe: null })).toBe(false);
    const rows = transformCrossSection([
      { ...full, pe: 10 },
      { ...full, pe: null },
      { ...full, pe: 20 },
    ]);
    expect(rows[1]?.pe).toBeNull();
  });
});

describe('dates and availability (brief §5, §7)', () => {
  it('uses the last trading day of each month', () => {
    expect(predictionDates('2026-01-01', '2026-06-30')).toEqual([
      '2026-01-30',
      '2026-02-27',
      '2026-03-31',
      '2026-04-30',
      '2026-05-29',
      '2026-06-30',
    ]);
  });

  it('ends a label window 21 trading days later', () => {
    expect(tradingDayAfter('2026-01-30')).toBe('2026-03-03');
  });

  it('reports the earliest date ≥ 90% of members had each feature', () => {
    const row = (pe: number | null) =>
      Object.fromEntries(FEATURE_NAMES_V1.map((n) => [n, n === 'pe' ? pe : 1]));
    const byDate = new Map([
      ['2020-01-31', [row(null), row(null), row(1), row(1)]],
      [
        '2020-02-28',
        [row(null), row(1), row(1), row(1), row(1), row(1), row(1), row(1), row(1), row(1)],
      ],
    ]);
    const a = featureAvailability(byDate);
    expect(a.mom_12_1).toBe('2020-01-31');
    expect(a.pe).toBe('2020-02-28');
  });
});
