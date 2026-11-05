import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { growthIndex, maxDrawdown, sharpe, timeWeightedReturn, tradeStats } from './metrics';
import { combineSeries, drawdowns } from './series';

const d = (v: string | number) => new Decimal(v);
const ds = (vs: number[]) => vs.map((v) => d(v));

describe('timeWeightedReturn', () => {
  it('is the plain return when no money moves', () => {
    const r = timeWeightedReturn(
      ds([101, 99, 110]).map((equity) => ({ equity })),
      d(100),
    );
    expect(r?.toString()).toBe('0.1');
  });

  it('does not count money added as gain', () => {
    // +10% on day 1, then $1,000 arrives and the whole lot is flat.
    const r = timeWeightedReturn([{ equity: d(110) }, { equity: d(1110), flow: d(1000) }], d(100));
    expect(r?.toString()).toBe('0.1');
  });

  it('starts from the first flow when there is no start', () => {
    const r = timeWeightedReturn([{ equity: d(105), flow: d(100) }, { equity: d(126) }]);
    expect(r?.toFixed(4)).toBe('0.2600');
    expect(timeWeightedReturn([])).toBeNull();
  });

  it('matches final over start without flows (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (values, start) => {
          const r = timeWeightedReturn(
            values.map((v) => ({ equity: d(v) })),
            d(start),
          )!;
          const expected = d(values.at(-1)!).div(start).minus(1);
          return r.minus(expected).abs().lt('1e-12');
        },
      ),
    );
  });
});

describe('growthIndex', () => {
  it('leaves out days before anything was invested', () => {
    const index = growthIndex([
      { equity: d(0) },
      { equity: d(100), flow: d(100) },
      { equity: d(90) },
    ]);
    expect(index.map((v) => v.toString())).toEqual(['1', '0.9']);
  });
});

describe('shared formulas', () => {
  it('drawdown and Sharpe behave as the back test always has', () => {
    expect(maxDrawdown(ds([110, 99, 120, 90, 130]), d(100)).toString()).toBe('0.25');
    expect(sharpe(ds(Array.from({ length: 19 }, (_, i) => 100 + i)), d(100))).toBeNull();
  });

  it('counts wins, losses and profit factor over net results', () => {
    const s = tradeStats(ds([30, -10, 20, -10, 0]));
    expect(s).toMatchObject({ trades: 5, wins: 2, losses: 2 });
    expect(s.winRate?.toString()).toBe('0.4');
    expect(s.profitFactor?.toString()).toBe('2.5');
    expect(s.averageNet?.toString()).toBe('6');
    expect(s.averageWin?.toString()).toBe('25');
    expect(s.averageLoss?.toString()).toBe('-10');
    expect(s.best?.toString()).toBe('30');
    expect(s.worst?.toString()).toBe('-10');
    expect(tradeStats([])).toMatchObject({ trades: 0, winRate: null, profitFactor: null });
  });
});

describe('combineSeries', () => {
  it('carries missed days forward and counts a newcomer as a flow', () => {
    const points = combineSeries([
      {
        start: d(100),
        points: new Map([
          ['2026-10-05', d(101)],
          ['2026-10-07', d(103)],
        ]),
      },
      { start: d(50), points: new Map([['2026-10-06', d(55)]]) },
    ]);
    expect(points.map((p) => [p.date, p.value.toString(), p.flow.toString()])).toEqual([
      ['2026-10-05', '101', '100'],
      ['2026-10-06', '156', '50'],
      ['2026-10-07', '158', '0'],
    ]);
    // 101/100, 156/151, 158/156
    expect(
      timeWeightedReturn(points.map((p) => ({ equity: p.value, flow: p.flow })))?.toFixed(6),
    ).toBe(d(101).div(100).times(d(156).div(151)).times(d(158).div(156)).minus(1).toFixed(6));
  });

  it('measures drawdowns from the running peak', () => {
    expect(drawdowns(ds([-5, 10, 4, 12, 12, 2])).map(String)).toEqual([
      '5',
      '0',
      '6',
      '0',
      '0',
      '10',
    ]);
  });
});
