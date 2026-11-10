import { describe, expect, it } from 'vitest';
import {
  CHART_HISTORY_CHUNK,
  CHART_RANGES,
  chartIntervalAllowed,
  chartWindow,
  defaultChartInterval,
  stepChartEnd,
} from './chart';

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
    // A day reaches back past a long weekend; the worker keeps only the last session.
    expect(chartWindow('1d', now).from).toBe('2026-10-28');
  });

  it('offers finer bars only for shorter ranges', () => {
    expect(chartIntervalAllowed('1d', '5m')).toBe(true);
    expect(chartIntervalAllowed('1m', '5m')).toBe(false);
    expect(chartIntervalAllowed('3m', '1h')).toBe(true);
    expect(chartIntervalAllowed('6m', '1h')).toBe(false);
    expect(chartIntervalAllowed('1d', '1d')).toBe(false);
    expect(chartIntervalAllowed('5y', '1d')).toBe(true);
    expect(defaultChartInterval('1d')).toBe('5m');
    expect(defaultChartInterval('1y')).toBe('1d');
  });

  it('ends on an earlier date the person went to, never after today (N196)', () => {
    const now = new Date('2026-11-03T15:00:00Z');
    expect(chartWindow('1w', now, '2025-03-14')).toEqual({ from: '2025-03-07', to: '2025-03-14' });
    expect(chartWindow('1w', now, '2027-01-01').to).toBe('2026-11-03');
    expect(chartWindow('1w', now, null).to).toBe('2026-11-03');
  });

  it('steps a day by trading days and longer ranges by their length (N196)', () => {
    const now = new Date('2026-11-03T15:00:00Z');
    // Tuesday 3 November back one session is Monday; Monday back one is Friday.
    expect(stepChartEnd('1d', null, -1, now)).toBe('2026-11-02');
    expect(stepChartEnd('1d', '2026-11-02', -1, now)).toBe('2026-10-30');
    // Forward from Friday skips the weekend; reaching today means "latest".
    expect(stepChartEnd('1d', '2026-10-30', 1, now)).toBe('2026-11-02');
    expect(stepChartEnd('1d', '2026-11-02', 1, now)).toBeNull();
    // Over Thanksgiving 2025 (27 November).
    expect(stepChartEnd('1d', '2025-11-28', -1, now)).toBe('2025-11-26');
    expect(stepChartEnd('1w', null, -1, now)).toBe('2026-10-27');
    expect(stepChartEnd('1w', '2026-10-27', 1, now)).toBeNull();
    expect(stepChartEnd('1m', '2026-06-30', 1, now)).toBe('2026-07-31');
  });

  it('fetches more history in chunks its bars are offered for (N197)', () => {
    for (const [interval, range] of Object.entries(CHART_HISTORY_CHUNK)) {
      expect(chartIntervalAllowed(range, interval as keyof typeof CHART_HISTORY_CHUNK)).toBe(true);
    }
  });
});
