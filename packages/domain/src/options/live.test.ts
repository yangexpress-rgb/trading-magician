import { describe, expect, it } from 'vitest';
import { deriveSignals } from './derive';
import { buildLiveChainView, expectedMoveCone } from './live';
import { F2_AS_OF, F2_EXPIRY_1, F2_EXPIRY_2, F2_Q, F2_R, F2_ROWS, F2_S } from './test-fixtures';

/** The Research live chain (brief §10 item 8): only computed values, per strike and per expiry. */
describe('the live chain view', () => {
  const derived = deriveSignals({ asOfDate: F2_AS_OF, S: F2_S, r: F2_R, q: F2_Q, rows: F2_ROWS });
  const view = buildLiveChainView({
    symbol: 'SPY',
    chainTime: '2026-11-28T21:30:00.000Z',
    asOfDate: F2_AS_OF,
    S: F2_S,
    priceSource: 'chain',
    r: F2_R,
    q: F2_Q,
    rows: F2_ROWS,
    values: derived.values,
    ivHistoryDays: 0,
    expiries: derived.expiries,
    atmStrikes: new Map([
      [F2_EXPIRY_1, 600],
      [F2_EXPIRY_2, 600],
    ]),
    skipped: 0,
  });

  it('keeps every expiry with its strikes in order and no source quote', () => {
    expect(view.expiries.map((e) => e.expiry)).toEqual([F2_EXPIRY_1, F2_EXPIRY_2]);
    const first = view.expiries[0]!;
    expect(first.atmStrike).toBe(600);
    const strikes = first.strikes.map((s) => s.strike);
    expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/"bid"|"ask"|"last"|"theo"/);
  });

  it('sums gamma exposure by strike to the figures row', () => {
    const call = view.gexByStrike.reduce((a, g) => a + g.callGex, 0);
    const put = view.gexByStrike.reduce((a, g) => a + g.putGex, 0);
    expect(call).toBeCloseTo(view.values.call_gex!, 0);
    expect(put).toBeCloseTo(view.values.put_gex!, 0);
    const oi = view.oiByStrike.reduce((a, o) => a + o.callOi + o.putOi, 0);
    expect(oi).toBe(F2_ROWS.reduce((a, r) => a + (r.openInterest ?? 0), 0));
  });

  it('draws the cone at each expiry’s ATM IV from the price', () => {
    const cone = expectedMoveCone(view);
    expect(cone[0]).toMatchObject({ date: F2_AS_OF, upper: F2_S, lower: F2_S });
    const at20 = cone.find((p) => p.days === 20)!;
    const iv = view.expiries[0]!.atmIv!;
    expect(at20.date).toBe(F2_EXPIRY_1);
    expect(at20.upper).toBeCloseTo(F2_S * (1 + iv * Math.sqrt(20 / 365)), 6);
    expect(at20.lower).toBeCloseTo(F2_S * (1 - iv * Math.sqrt(20 / 365)), 6);
    expect(cone.every((p) => p.days <= 60)).toBe(true);
  });
});
