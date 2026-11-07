import type { Bar, IndicatorExpr } from '@tm/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import type { BacktestResult } from './results';
import {
  A,
  B,
  INSTRUMENTS,
  close,
  compare,
  dailyBars,
  inputs,
  leg,
  loaded,
  strategy,
  type Row,
} from './test-utils';

const FROM = '2024-03-04';
const DAYS = 40;

const sma = (instrumentId: string, period: number): IndicatorExpr => ({
  kind: 'indicator',
  id: `sma-${instrumentId}-${period}`,
  name: 'SMA',
  params: { period },
  instrumentId,
  field: 'close',
  interval: '1d',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset: 0,
});

/** Daily OHLCV rows from a random walk of percentage moves. */
const walk = fc
  .array(
    fc.tuple(
      fc.integer({ min: -400, max: 400 }),
      fc.integer({ min: 0, max: 200 }),
      fc.integer({ min: 1, max: 500 }),
    ),
    {
      minLength: DAYS,
      maxLength: DAYS,
    },
  )
  .map((steps) => {
    let px = 100;
    return steps.map(([move, range, volume]): Row => {
      const open = px;
      px = Math.max(1, Math.round(px * (1 + move / 10_000) * 100) / 100);
      const spread = (px * range) / 10_000;
      return [open, Math.max(open, px) + spread, Math.min(open, px) - spread, px, volume * 100];
    });
  });

/** A trend-following pair: long A and short B while A is above its average. */
const definition = (period: number, policy: 'concurrent' | 'sequential' | 'after_prior_fill') => {
  const def = strategy(
    compare(close(A), 'crosses_above', sma(A, period)),
    [
      leg('long-a', { timeInForce: 'gtc' }),
      leg('short-b', { instrumentId: B, side: 'sell_short', timeInForce: 'gtc' }),
    ],
    compare(close(A), 'crosses_below', sma(A, period)),
    [leg('close-a', { side: 'close' }), leg('close-b', { instrumentId: B, side: 'close' })],
  );
  def.execution.multiLegPolicy = policy;
  def.execution.legTimeoutSec = 3 * 86_400;
  def.execution.reentry = { mode: 'pyramid', cap: 2 };
  def.entry.trigger.mode = 'while_true';
  def.entry.trigger.cooldownBars = 1;
  return def;
};

const run = (def: ReturnType<typeof definition>, a: Bar[], b: Bar[]): BacktestResult =>
  simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs('2024-03-04', '2024-12-31', { maxVolumePct: '5' }),
    data: loaded({ [A]: a, [B]: b }),
  });

const scenario = fc.record({
  a: walk,
  b: walk,
  futureA: walk,
  futureB: walk,
  cut: fc.integer({ min: 1, max: DAYS - 1 }),
  period: fc.integer({ min: 2, max: 8 }),
  policy: fc.constantFrom(
    'concurrent' as const,
    'sequential' as const,
    'after_prior_fill' as const,
  ),
});

describe('simulate: no lookahead', () => {
  it('never lets bars after a point change fills or equity before it', () => {
    let traded = 0;
    let cutsWithFillsBefore = 0;
    fc.assert(
      fc.property(scenario, ({ a, b, futureA, futureB, cut, period, policy }) => {
        const def = definition(period, policy);
        const original = run(def, dailyBars(FROM, a), dailyBars(FROM, b));
        const changed = run(
          def,
          dailyBars(FROM, [...a.slice(0, cut), ...futureA.slice(cut)]),
          dailyBars(FROM, [...b.slice(0, cut), ...futureB.slice(cut)]),
        );
        const cutStart = dailyBars(FROM, a)[cut]?.start ?? '';
        const before = (r: BacktestResult) => ({
          fills: r.fills.filter((f) => f.time < cutStart),
          equity: r.equity.filter((p) => p.time < cutStart),
        });
        expect(before(changed)).toEqual(before(original));
        traded += original.fills.length > 0 ? 1 : 0;
        cutsWithFillsBefore += before(original).fills.length > 0 ? 1 : 0;
      }),
      { numRuns: 150 },
    );
    // Guard against a vacuous pass: most runs must trade, many before the cut.
    expect(traded).toBeGreaterThan(100);
    expect(cutsWithFillsBefore).toBeGreaterThan(50);
  });

  it('is deterministic for any bars', () => {
    fc.assert(
      fc.property(scenario, ({ a, b, period, policy }) => {
        const def = definition(period, policy);
        expect(run(def, dailyBars(FROM, a), dailyBars(FROM, b))).toEqual(
          run(def, dailyBars(FROM, a), dailyBars(FROM, b)),
        );
      }),
      { numRuns: 50 },
    );
  });

  it('keeps cash and positions consistent with the fills', () => {
    fc.assert(
      fc.property(scenario, ({ a, b, period, policy }) => {
        const r = run(definition(period, policy), dailyBars(FROM, a), dailyBars(FROM, b));
        const net = r.trades.reduce((s, t) => s + Number(t.netPnl), 0);
        expect(Number(r.metrics.finalEquity)).toBeCloseTo(100_000 + net, 0);
        for (const p of r.equity)
          expect(Number(p.equity)).toBeCloseTo(Number(p.cash) + Number(p.netExposure), 1);
      }),
      { numRuns: 50 },
    );
  });
});
