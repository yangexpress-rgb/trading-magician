import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import {
  breakoutDonchian,
  breakoutDonchianPriorBars,
  longShortBreakout,
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

describe('item 8: long and short entry groups in one strategy', () => {
  // Flat, an upside breakout and a rally, a drop that exits it, flat again,
  // a downside breakdown and a slide, a jump that covers it, flat.
  const rows: Row[] = [
    ...Array.from({ length: 30 }, (): Row => [100, 101, 99, 100]),
    [100, 104, 100, 103], // 30: long breakout
    ...Array.from({ length: 10 }, (_, i): Row => {
      const c = 105 + 2 * i;
      return [c - 1, c + 0.5, c - 0.5, c];
    }),
    [123, 123, 103, 104], // 41: below the 10-day low: long exit
    ...Array.from({ length: 20 }, (): Row => [108, 109, 107, 108]),
    [108, 108, 102, 103], // 62: below the 20-day low: short entry
    ...Array.from({ length: 10 }, (_, i): Row => {
      const c = 102 - 2 * i;
      return [c + 1, c + 0.5, c - 0.5, c];
    }),
    [84, 104, 84, 103], // 73: above the 10-day high: short exit
    ...Array.from({ length: 10 }, (): Row => [100, 101, 99, 100]),
  ];
  const bars = dailyBars('2025-01-02', rows);
  const run = (def = longShortBreakout()) =>
    simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2025-01-02', '2025-12-31'),
      data: loaded({ [SPY]: bars }),
    });

  it('takes exactly one long and one short trade, each with correctly signed P&L', () => {
    const r = run();
    expect(r.trades.map((t) => [t.direction, t.group, t.status])).toEqual([
      ['long', 'Group 1', 'closed'],
      ['short', 'Short breakdown', 'closed'],
    ]);
    const [long, short] = r.trades;
    // Long: bought at bar 31's open, sold at bar 42's. Short: sold at 63's, covered at 74's.
    expect(long!.entryTime).toBe(bars[31]!.start);
    expect(long!.exitTime).toBe(bars[42]!.start);
    expect(short!.entryTime).toBe(bars[63]!.start);
    expect(short!.exitTime).toBe(bars[74]!.start);
    for (const t of [long!, short!]) {
      const entry = t.legs.find((l) => l.phase === 'entry')!;
      const exit = t.legs.find((l) => l.phase === 'exit')!;
      const qty = Number(entry.quantity);
      const move = Number(exit.averagePrice) - Number(entry.averagePrice);
      const expected = (t.direction === 'long' ? move : -move) * qty;
      expect(expected).toBeGreaterThan(0);
      // Net P&L is the signed move at the fill prices (slippage included), less any borrow.
      expect(Number(t.netPnl)).toBeLessThanOrEqual(expected + 0.01);
      expect(Number(t.netPnl)).toBeGreaterThanOrEqual(expected - Number(t.costs) - 0.01);
      expect(Number(t.netPnl)).toBeGreaterThan(0);
      expect(Number(t.returnPct)).toBeGreaterThan(0);
    }
    expect(short!.legs.map((l) => l.side)).toEqual(['sell_short', 'close']);
    expect(r.metrics.winRatePct).toBe('100');
    expect(r.groupConditions?.map((g) => [g.label, g.direction, g.entry.fired])).toEqual([
      ['Short breakdown', 'short', 1],
    ]);
    expect(r.assumptions.join('\n')).toMatch(/Short trades make \(entry price − exit price\)/);
    expect(r.assumptions.join('\n')).toMatch(/Whether SPY can be borrowed is unknown/);
  });

  it('never flips: a short signal while the long is open does nothing', () => {
    // The same series, but the long's exit never fires: the breakdown finds it still open.
    const def = longShortBreakout();
    def.exit.condition.children = [];
    const r = run(def);
    expect(r.trades.map((t) => t.direction)).toEqual(['long']);
    const blocked = r.groupConditions?.[0]?.entry.bars.filter((b) => b.outcome === 'cycle_open');
    expect(blocked?.length).toBeGreaterThan(0);
  });

  it('leaves long-only results without directions (regression)', () => {
    const r = simulate({
      definition: breakoutDonchianPriorBars(),
      instruments: INSTRUMENTS,
      inputs: inputs('2025-01-02', '2025-12-31'),
      data: loaded({ [SPY]: bars }),
    });
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.trades.every((t) => t.direction === undefined)).toBe(true);
    expect(r.groupConditions).toBeUndefined();
  });
});
