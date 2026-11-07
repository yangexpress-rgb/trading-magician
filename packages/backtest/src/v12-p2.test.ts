import { atr as atrSeries } from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import {
  breakoutDonchian,
  breakoutDonchianPriorBars,
  longShortBreakout,
  riskAtrTrend,
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

describe('item 9: risk-based sizing and the ATR stop', () => {
  const bars = spyBars();
  const run = (def = riskAtrTrend()) =>
    simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2023-11-01', '2025-06-30'),
      data: loaded({ [SPY]: bars }),
    });

  it('sizes each entry from equity, risk % and ATR at entry, checkable by hand', () => {
    const r = run();
    const sized = r.trades.filter((t) => t.sizing);
    expect(sized.length).toBeGreaterThanOrEqual(3);
    for (const t of [sized[0]!, sized[Math.floor(sized.length / 2)]!, sized.at(-1)!]) {
      const s = t.sizing!;
      // quantity = floor((equity × risk% ÷ 100) ÷ (ATR × multiple)), from the figures shown.
      const byHand = Math.floor(
        (Number(s.equity) * Number(s.riskPct)) / 100 / (Number(s.atr) * Number(s.atrMultiple)),
      );
      expect(Number(s.riskQuantity)).toBe(byHand);
      expect(s.cappedBy).toBeUndefined();
      expect(Number(s.quantity)).toBe(byHand);
      expect(t.legs.find((l) => l.phase === 'entry')?.quantity).toBe(s.quantity);
      // The ATR is ATR(20) of the daily bars up to the bar Entry was decided on.
      const fill = bars.findIndex((b) => b.start === t.entryTime);
      const atr = atrSeries(bars.slice(0, fill), 20).at(-1)!;
      expect(Number(s.atr)).toBeCloseTo(atr.toNumber(), 4);
      expect(s.stopDistance).toBe(new Decimal(s.atr).times(2).toString());
    }
  });

  it('exits on the ATR stop when a close falls more than 2 × entry ATR, with no Exit condition', () => {
    // The SPY-like walk into the first entry, then a slide of 1.5% a day.
    const head = spyBars(300);
    const rows: Row[] = head.map((b) => [
      b.open.toNumber(),
      b.high.toNumber(),
      b.low.toNumber(),
      b.close.toNumber(),
      b.volume.toNumber(),
    ]);
    let px = rows.at(-1)![3];
    for (let i = 0; i < 15; i++) {
      const next = Math.round(px * 0.985 * 100) / 100;
      rows.push([px, px + 0.2, next - 0.2, next, 60_000_000]);
      px = next;
    }
    const slide = dailyBars('2023-01-03', rows);
    const def = riskAtrTrend();
    def.exit.condition.children = [];
    const r = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2023-11-01', '2025-06-30'),
      data: loaded({ [SPY]: slide }),
    });
    const stopped = r.trades.filter((t) => t.exitReason === 'atr_stop');
    expect(stopped).toHaveLength(1);
    const t = stopped[0]!;
    const level = Number(t.atrStop!.level);
    expect(level).toBeCloseTo(Number(t.atrStop!.entryPrice) - 2 * Number(t.atrStop!.atr), 3);
    expect(t.atrStop!.atr).toBe(t.sizing!.atr);
    // Decided on the close before the exit fill: that close is below the level, no earlier one was.
    const fill = slide.findIndex((b) => b.start === t.exitTime);
    expect(slide[fill - 1]!.close.toNumber()).toBeLessThan(level);
    const entry = slide.findIndex((b) => b.start === t.entryTime);
    for (const b of slide.slice(entry, fill - 1))
      expect(b.close.toNumber()).toBeGreaterThanOrEqual(level);
    // No Exit condition fired: the conditions report never fired.
    expect(r.conditions?.exit.fired).toBe(0);
  });

  it('caps a risk-sized order at the maximum order size instead of breaking it', () => {
    const def = riskAtrTrend();
    def.risk.maxOrderNotional = '10000';
    const t = run(def).trades.find((x) => x.sizing)!;
    expect(t.sizing!.cappedBy).toBe('max_order_size');
    const entry = t.legs.find((l) => l.phase === 'entry')!;
    expect(Number(entry.quantity)).toBeLessThan(Number(t.sizing!.riskQuantity));
  });

  it('skips the entry, saying why, while the ATR has too little history', () => {
    const def = riskAtrTrend();
    def.entry.orders[0]!.quantity.atrPeriod = 400;
    def.exit.rules = [];
    // ATR(400) needs 401 daily bars: none of the bars up to mid-2024 have that much history.
    const r = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2023-11-01', '2024-06-28'),
      data: loaded({ [SPY]: bars }),
    });
    const skipped = r.orders?.filter((o) => o.reason === 'no_atr') ?? [];
    expect(skipped.length).toBeGreaterThan(0);
    expect(r.fills).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toContain(
      'Some risk-sized entries were skipped because the ATR had too little history',
    );
  });
});
