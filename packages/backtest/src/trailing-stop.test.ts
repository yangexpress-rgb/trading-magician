import {
  parseDefinition,
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

describe('the trailing stop as an Exit when condition (N217, ADR 0074)', () => {
  /** The saved form: schema 3, with the rule, and an Exit that fires on any check it holds. */
  const saved = (percent: string) => {
    const def = trailing(percent);
    def.exit.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
    return { ...JSON.parse(JSON.stringify(def)), schemaVersion: 3 } as Record<string, unknown>;
  };

  it('reads a saved rule as "Off best close since entry % > N" and exits on the same closes', () => {
    for (const percent of ['1', '3']) {
      const doc = saved(percent);
      const asCondition = parseDefinition(doc);
      expect(asCondition.exit.rules ?? []).toEqual([]);
      expect(JSON.stringify(asCondition.exit.condition)).toContain('off_peak_pct');
      // The rule as it ran before: the same strategy, rule kept, read as schema 4.
      const asRule = parseDefinition({ ...doc, schemaVersion: 4 });
      expect(asRule.exit.rules?.[0]?.kind).toBe('trailingStop');
      const a = run(asRule);
      const b = run(asCondition);
      expect(a.trades.some((t) => t.exitReason === 'trailing_stop')).toBe(true);
      const fills = (r: typeof a) => r.fills.map((f) => [f.time, f.side, f.quantity, f.price]);
      expect(fills(b)).toEqual(fills(a));
      // The exits now read as Exit when, with the value in the bar check.
      expect(b.trades.some((t) => t.exitReason === 'trailing_stop')).toBe(false);
    }
  });

  it('keeps the rule as saved where Fire when could hold the condition back', () => {
    const doc = saved('1');
    (doc.exit as { trigger: unknown }).trigger = {
      mode: 'on_transition',
      cooldownBars: 0,
      confirmationBars: 0,
    };
    expect(parseDefinition(doc).exit.rules?.[0]?.kind).toBe('trailingStop');
  });
});
