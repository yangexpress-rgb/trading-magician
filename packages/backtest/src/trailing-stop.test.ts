import {
  trailingPeak,
  trailingStopHit,
  trailingStopLevel,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import { riskAtrTrend, SPY, spyBars } from './fixtures/spy-strategies';
import { inputs, loaded } from './test-utils';
import type { InstrumentRef } from './index';

/**
 * The trailing stop (ADR 0059): from the entry price it follows the best daily
 * close since entry, and a close more than the percent off that peak exits.
 */

const INSTRUMENTS = new Map<string, InstrumentRef>([
  [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
]);

function trailing(percent: string): StrategyDefinition {
  const def = riskAtrTrend();
  def.exit.rules = [{ kind: 'trailingStop', id: 'ts', percent }];
  def.exit.condition.children = [];
  return def;
}

const bars = spyBars();
const run = (def: StrategyDefinition) =>
  simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs('2023-11-01', '2025-06-30'),
    data: loaded({ [SPY]: bars }),
  });

describe('the trailing stop level', () => {
  it('is 1% under the peak for a long and over it for a short', () => {
    expect(trailingStopLevel(new Decimal(100), '1', true).toString()).toBe('99');
    expect(trailingStopLevel(new Decimal(100), '1', false).toString()).toBe('101');
    expect(trailingStopHit(new Decimal(98.99), new Decimal(99), true)).toBe(true);
    expect(trailingStopHit(new Decimal(99), new Decimal(99), true)).toBe(false);
    expect(trailingStopHit(new Decimal(101.01), new Decimal(101), false)).toBe(true);
  });
  it('only moves the peak in the position’s favour', () => {
    expect(trailingPeak(new Decimal(100), new Decimal(103), true).toString()).toBe('103');
    expect(trailingPeak(new Decimal(103), new Decimal(101), true).toString()).toBe('103');
    expect(trailingPeak(new Decimal(100), new Decimal(97), false).toString()).toBe('97');
    expect(trailingPeak(new Decimal(97), new Decimal(99), false).toString()).toBe('97');
  });
});

describe('a back test with a trailing stop', () => {
  it('exits on the first close more than 1% below the best close since entry', () => {
    const r = run(trailing('1'));
    const exits = r.trades.filter((t) => t.exitReason === 'trailing_stop');
    expect(exits.length).toBeGreaterThan(0);
    for (const t of exits) {
      const entry = bars.findIndex((b) => b.start === t.entryTime);
      const fill = bars.findIndex((b) => b.start === t.exitTime);
      // Walk the closes from the entry bar to the bar the exit was decided on.
      let peak = new Decimal(t.legs.find((l) => l.phase === 'entry')!.averagePrice!);
      let firedAt = -1;
      for (let i = entry; i < fill; i++) {
        const close = bars[i]!.close;
        if (close.lt(peak.times(0.99))) {
          firedAt = i;
          break;
        }
        if (close.gt(peak)) peak = close;
      }
      // The exit fills at the open after the first close past the level.
      expect(firedAt).toBe(fill - 1);
    }
    expect(r.assumptions.some((a) => a.includes('trailing stop'))).toBe(true);
  });

  it('holds longer with a wider trail', () => {
    const tight = run(trailing('1')).trades.filter((t) => t.exitReason === 'trailing_stop');
    const wide = run(trailing('8')).trades.filter((t) => t.exitReason === 'trailing_stop');
    const held = (ts: typeof tight) =>
      ts.reduce((n, t) => n + (Date.parse(t.exitTime!) - Date.parse(t.entryTime!)), 0) /
      Math.max(ts.length, 1);
    expect(wide.length).toBeLessThan(tight.length);
    expect(held(wide)).toBeGreaterThan(held(tight));
  });
});
