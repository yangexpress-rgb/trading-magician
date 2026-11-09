import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import { SPY, QQQ, riskAtrTrend, spyBars, twoLegs } from './fixtures/spy-strategies';
import {
  A,
  INSTRUMENTS,
  close,
  compare,
  constant,
  dailyBars,
  inputs,
  leg,
  loaded,
  strategy,
} from './test-utils';
import type { InstrumentRef } from './index';

/**
 * What the cycle card reads (N166): the cycle on each Entry bar that opened
 * one, each instrument's share of a cycle's P/L, and the trailing stop's last check.
 */

const crossover = () =>
  strategy(
    compare(close(), 'gt', constant('100')),
    [leg('buy-a')],
    compare(close(), 'lt', constant('100')),
    [leg('sell-a', { side: 'sell' })],
  );

describe('the cycle card records', () => {
  it('links each firing Entry bar to the cycle it opened', () => {
    const bars = dailyBars('2024-03-04', [
      [99, 99, 99, 99],
      [101, 101, 101, 101], // Entry fires: cycle 1
      [100, 103, 99, 102],
      [98, 98, 98, 98], // Exit fires
      [99, 99, 99, 99],
      [101, 101, 101, 101], // Entry fires again: cycle 2
      [102, 102, 102, 102],
    ]);
    const r = simulate({
      definition: crossover(),
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-12'),
      data: loaded({ [A]: bars }),
    });
    const fired = r.conditions!.entry.bars.filter((b) => b.outcome === 'fired');
    expect(fired.map((b) => b.cycle)).toEqual([1, 2]);
    // Bars that didn't fire carry no cycle.
    expect(r.conditions!.entry.bars.filter((b) => b.outcome !== 'fired').every((b) => b.cycle === undefined)).toBe(true);
    // The firing bar is when the cycle's Entry order was decided.
    for (const b of fired) {
      const order = r.orders!.find((o) => o.cycle === b.cycle && o.phase === 'entry');
      expect(order?.decidedAt).toBe(b.time);
    }
  });

  it("splits a two-leg cycle's P/L by instrument, adding up to the trade", () => {
    const r = simulate({
      definition: twoLegs(),
      instruments: new Map<string, InstrumentRef>([
        [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
        [QQQ, { symbol: 'QQQ', assetClass: 'etf', lotSize: '1' }],
      ]),
      inputs: inputs('2023-11-01', '2025-06-30'),
      data: loaded({ [SPY]: spyBars(), [QQQ]: spyBars(640, 11) }),
    });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades.filter((x) => x.status !== 'aborted')) {
      const d = r.cycles!.find((c) => c.cycle === t.cycle)!;
      expect(d.instruments.map((i) => i.symbol).sort()).toEqual(['QQQ', 'SPY']);
      const sum = (k: 'grossPnl' | 'costs' | 'netPnl') =>
        d.instruments.reduce((s, i) => s.plus(i[k]), new Decimal(0));
      // Each part is rounded to cents, so the sum can be a cent off the total.
      expect(sum('netPnl').minus(t.netPnl).abs().lte(0.02)).toBe(true);
      expect(sum('grossPnl').minus(t.grossPnl).abs().lte(0.02)).toBe(true);
      expect(sum('costs').minus(t.costs).abs().lte(0.02)).toBe(true);
    }
  });

  it('keeps the trailing stop’s last check, with the level the hit close crossed', () => {
    const def = riskAtrTrend();
    def.exit.rules = [{ kind: 'trailingStop', id: 'ts', percent: '1' }];
    def.exit.condition.children = [];
    const r = simulate({
      definition: def,
      instruments: new Map<string, InstrumentRef>([
        [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
      ]),
      inputs: inputs('2023-11-01', '2025-06-30'),
      data: loaded({ [SPY]: spyBars() }),
    });
    const hits = r.trades.filter((t) => t.exitReason === 'trailing_stop');
    expect(hits.length).toBeGreaterThan(0);
    for (const t of hits) {
      const ts = r.cycles!.find((c) => c.cycle === t.cycle)!.trailingStop!;
      expect(ts.hit).toBe(true);
      expect(ts.direction).toBe('long');
      expect(new Decimal(ts.close).lt(ts.level)).toBe(true);
      expect(new Decimal(ts.level).toFixed(2)).toBe(new Decimal(ts.peak).times(0.99).toFixed(2));
      expect(new Decimal(ts.peak).gte(ts.entryPrice)).toBe(true);
      expect(ts.checks).toBeGreaterThan(0);
      // Decided on the close before the exit filled.
      expect(ts.time < t.exitTime!).toBe(true);
    }
  });
});
