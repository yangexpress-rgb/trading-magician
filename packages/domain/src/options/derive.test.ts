import { describe, expect, it } from 'vitest';
import { deriveSignals, varianceInterpolate } from './derive';
import { isMonthlyExpiry, ivRankPercentile, signalAt, type OptionSignal } from './signals';
import { nyDate, tradingDaysBetween } from '../market/calendar';
import {
  F2_AS_OF,
  F2_EXPIRY_1,
  F2_PRIOR_IV30,
  F2_Q,
  F2_R,
  F2_REALIZED_VOL_20,
  F2_ROWS,
  F2_S,
} from './test-fixtures';

/** Fixture F2 (options data brief v2 §7): every derived value of the canned SPY day. */
describe('derived option signals (F2)', () => {
  const result = deriveSignals({
    asOfDate: F2_AS_OF,
    S: F2_S,
    r: F2_R,
    q: F2_Q,
    rows: F2_ROWS,
    realizedVol20: F2_REALIZED_VOL_20,
    priorIv30: F2_PRIOR_IV30,
    minHistory: 5,
  });
  const v = result.values;
  const near = (actual: number | null, expected: number, tol: number) => {
    expect(actual).not.toBeNull();
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tol);
  };

  it('IV30 interpolates ATM variance to exactly 30 days', () => {
    near(v.iv30, 0.1972, 0.001);
    expect(varianceInterpolate(20, 0.185, 45, 0.205)).toBeCloseTo(Math.sqrt(1.16715 / 30), 10);
  });

  it('ATM IV is the mean of the ATM call and put at the nearest expiry', () => {
    near(v.atm_iv, 0.185, 0.001);
  });

  it('expected moves from IV30, and the straddle move from the nearest expiry', () => {
    near(v.expected_move_5d_usd, 13.85, 0.05);
    near(v.expected_move_5d_pct, 0.0231, 0.001);
    near(v.expected_move_1d_usd, 6.19, 0.05);
    near(v.expected_move_1d_pct, 0.0103, 0.001);
    near(v.straddle_move_pct, 0.0262, 0.001);
  });

  it('skew is the 25-delta put minus call, each at 30 days', () => {
    near(v.skew_30d, 0.04, 0.001);
  });

  it('term structure is near IV over IV30', () => {
    near(v.term_structure, 0.938, 0.001);
  });

  it('IV rank and percentile over the sample window', () => {
    near(v.iv_rank_252d, 74.5, 0.1);
    near(v.iv_percentile_252d, 80, 0.001);
    expect(result.ivHistoryDays).toBe(5);
  });

  it('IV over realised volatility', () => {
    near(v.iv_rv_ratio, 1.23, 0.01);
  });

  it('put/call ratios at the nearest expiry', () => {
    near(v.put_call_volume, 0.9444, 0.001);
    near(v.put_call_oi, 1.0, 0.001);
  });

  it('gamma exposure over every expiry, to the dollar', () => {
    expect(Math.round(v.call_gex as number)).toBe(105_120_000);
    expect(Math.round(v.put_gex as number)).toBe(107_280_000);
    expect(Math.round(v.net_gex as number)).toBe(-2_160_000);
    expect(result.gexSkipped).toBe(0);
  });

  it('open-interest levels at the nearest monthly expiry', () => {
    expect(isMonthlyExpiry(F2_EXPIRY_1)).toBe(true);
    expect(v.call_wall).toBe(610);
    expect(v.put_wall).toBe(590);
    expect(v.max_pain).toBe(600);
  });

  it('per-expiry rows for both expiries', () => {
    expect(result.expiries).toHaveLength(2);
    const [e1, e2] = result.expiries;
    expect(e1).toMatchObject({ daysToExpiry: 20, putVolume: 17_000, callVolume: 18_000 });
    near(e1?.atmIv ?? null, 0.185, 1e-9);
    near(e2?.atmIv ?? null, 0.205, 1e-9);
    expect(e1?.putIv25d).toBe(0.2);
    expect(e1?.callIv25d).toBe(0.16);
    expect(e2).toMatchObject({ daysToExpiry: 45, putOi: 17_000, callOi: 18_000 });
  });
});

describe('missing data is unknown, never zero', () => {
  it('a zero or missing computed IV is missing', () => {
    const rows = F2_ROWS.map((r) => ({ ...r, iv: r.strike === 600 ? 0 : r.iv }));
    const { values } = deriveSignals({ asOfDate: F2_AS_OF, S: F2_S, r: F2_R, q: F2_Q, rows });
    expect(values.iv30).toBeNull();
    expect(values.atm_iv).toBeNull();
    expect(values.expected_move_5d_pct).toBeNull();
    expect(values.term_structure).toBeNull();
    expect(values.iv_rank_252d).toBeNull();
  });

  it('a 25-delta leg outside 0.15–0.35 makes the skew unknown', () => {
    const rows = F2_ROWS.map((r) =>
      r.right === 'put' && r.strike === 590 ? { ...r, delta: -0.4 } : r,
    );
    const { values } = deriveSignals({ asOfDate: F2_AS_OF, S: F2_S, r: F2_R, q: F2_Q, rows });
    expect(values.skew_30d).toBeNull();
  });

  it('no call volume, no open interest, no quotes', () => {
    const rows = F2_ROWS.map((r) => ({
      ...r,
      volume: r.right === 'call' ? 0 : r.volume,
      openInterest: null,
      bid: null,
      ask: null,
    }));
    const { values } = deriveSignals({ asOfDate: F2_AS_OF, S: F2_S, r: F2_R, q: F2_Q, rows });
    expect(values.put_call_volume).toBeNull();
    expect(values.put_call_oi).toBeNull();
    expect(values.net_gex).toBeNull();
    expect(values.straddle_move_pct).toBeNull();
    expect(values.max_pain).toBeNull();
  });

  it('rank and percentile wait for the history they need', () => {
    expect(ivRankPercentile(0.2, [0.1, 0.3], 120)).toEqual({
      rank: null,
      percentile: null,
      days: 2,
    });
    expect(ivRankPercentile(0.2, new Array(120).fill(0.2), 120).rank).toBeNull(); // flat year
  });
});

describe('point in time (brief §5.3)', () => {
  const row = (asOfDate: string): OptionSignal => ({
    asOfDate,
    source: 'recorded',
    ivHistoryDays: 0,
    values: {} as OptionSignal['values'],
  });
  const list = [row('2026-11-02'), row('2026-11-03')];
  const at = (iso: string) => signalAt(list, Date.parse(iso), (ms) => nyDate(new Date(ms)));

  it('a day is visible from its close, never to an earlier bar of the same day', () => {
    expect(at('2026-11-03T20:59:00Z')?.asOfDate).toBe('2026-11-02'); // 15:59 New York
    expect(at('2026-11-03T21:00:00Z')?.asOfDate).toBe('2026-11-03'); // 16:00, the daily bar's end
    expect(at('2026-11-02T15:00:00Z')).toBeUndefined();
  });

  it('a signal more than five trading days old is unknown', () => {
    expect(tradingDaysBetween('2026-11-03', '2026-11-10')).toBe(5);
    expect(at('2026-11-10T21:00:00Z')?.asOfDate).toBe('2026-11-03');
    expect(at('2026-11-11T21:00:00Z')).toBeUndefined();
  });
});
