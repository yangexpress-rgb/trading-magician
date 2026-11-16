import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import { SPY, spyBars, trendSma200 } from './fixtures/spy-strategies';
import type { InstrumentRef } from './index';
import { inputs, loaded } from './test-utils';

/**
 * The strategy trailing stop (N290, ADR 0099): measured on the whole strategy,
 * every position closes at the bar's close when equity falls more than the
 * limit % of the money in positions below its best since entry.
 */

const INSTRUMENTS = new Map<string, InstrumentRef>([
  [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
]);
const bars = spyBars();
const run = (trailingStopPct: string | undefined) => {
  const def = trendSma200();
  if (trailingStopPct) def.risk.trailingStopPct = trailingStopPct;
  else delete def.risk.trailingStopPct;
  return simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs('2023-11-01', '2025-06-30'),
    data: loaded({ [SPY]: bars }),
  });
};

describe('the strategy trailing stop in a back test', () => {
  it('closes the position on the first close that gives back more than 1% of its value', () => {
    const r = run('1');
    const stops = r.trades.filter((t) => t.exitReason === 'strategy_trailing_stop');
    expect(stops.length).toBeGreaterThan(0);
    for (const t of stops) {
      const entry = t.legs.find((l) => l.phase === 'entry')!;
      const qty = new Decimal(entry.quantity);
      const fills = r.fills.filter((f) => f.cycle === t.cycle);
      const bought = fills.find((f) => f.phase === 'entry')!;
      const closed = fills.find((f) => f.phase === 'flatten')!;
      const first = bars.findIndex((b) => b.start === bought.time);
      // Closed at the close of the bar the stop fired on.
      const firedAt = bars.findIndex((b) => b.end === closed.time);
      expect(firedAt).toBeGreaterThanOrEqual(first);
      // Walk the closes: the best value, and the first drop past 1% of the most held.
      let best = qty.times(bought.price);
      let most = best;
      let expected = -1;
      for (let i = first; i <= firedAt; i++) {
        const value = qty.times(bars[i]!.close);
        if (value.gt(best)) best = value;
        if (value.gt(most)) most = value;
        if (best.minus(value).gt(most.times('0.01'))) {
          expected = i;
          break;
        }
      }
      expect(firedAt).toBe(expected);
    }
    expect(r.warnings.map((w) => w.code)).toContain('strategy_trailing_stop');
  });

  it('is off when the limit is blank, and a wider limit holds longer', () => {
    expect(run(undefined).trades.some((t) => t.exitReason === 'strategy_trailing_stop')).toBe(
      false,
    );
    const count = (pct: string) =>
      run(pct).trades.filter((t) => t.exitReason === 'strategy_trailing_stop').length;
    expect(count('1')).toBeGreaterThan(count('5'));
  });
});
