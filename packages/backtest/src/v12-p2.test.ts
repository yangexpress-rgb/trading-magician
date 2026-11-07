import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import {
  breakoutDonchian,
  breakoutDonchianPriorBars,
  SPY,
  spyBars,
} from './fixtures/spy-strategies';
import { dailyBars, inputs, loaded, type Row } from './test-utils';
import type { InstrumentRef } from './index';

/**
 * Acceptance checks for Design v1.2 P2 (items 7 to 10).
 */

const INSTRUMENTS = new Map<string, InstrumentRef>([
  [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
]);

describe('item 7: HIGHEST / LOWEST one bar back (the breakout that never fired)', () => {
  it('fires on a synthetic series whose bar 21 closes above the 20 bars before it', () => {
    // Thirty quiet bars (99–106); the next closes at 112 (high 113); then a slow fade.
    const rows: Row[] = [
      ...Array.from({ length: 30 }, (_, i): Row => [100, 104 + (i % 3), 99, 101 + (i % 3)]),
      [104, 113, 103, 112],
      ...Array.from({ length: 10 }, (): Row => [110, 111, 109, 110]),
    ];
    const bars = dailyBars('2025-01-02', rows);
    const run = (def: ReturnType<typeof breakoutDonchian>) =>
      simulate({
        definition: def,
        instruments: INSTRUMENTS,
        inputs: inputs('2025-01-02', '2025-03-31'),
        data: loaded({ [SPY]: bars }),
      });
    const prior = run(breakoutDonchianPriorBars());
    expect(prior.trades.length).toBe(1);
    // Signal on the breakout bar's close, filled at the next bar's open.
    expect(prior.trades[0]?.entryTime).toBe(bars[31]?.start);
    // The v1.1 window (current bar included) never fires.
    expect(run(breakoutDonchian()).trades).toEqual([]);
  });

  it('turns the zero-trade SPY Donchian 20/10 into trades, each above the prior 20 highs', () => {
    const bars = spyBars();
    const r = simulate({
      definition: breakoutDonchianPriorBars(),
      instruments: INSTRUMENTS,
      inputs: inputs('2023-11-01', '2025-06-30'),
      data: loaded({ [SPY]: bars }),
    });
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      const fill = bars.findIndex((b) => b.start === t.entryTime);
      const signal = bars[fill - 1]!;
      const prior20 = bars.slice(fill - 21, fill - 1);
      expect(prior20).toHaveLength(20);
      const top = Math.max(...prior20.map((b) => b.high.toNumber()));
      expect(signal.close.toNumber()).toBeGreaterThan(top);
    }
  });
});
