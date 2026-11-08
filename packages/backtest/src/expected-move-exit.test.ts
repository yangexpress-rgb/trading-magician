import {
  expectedMoveBand,
  expectedMoveHit,
  OPTION_SIGNAL_FIELDS,
  type OptionSignal,
  type OptionSignalValues,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import { riskAtrTrend, SPY, spyBars } from './fixtures/spy-strategies';
import { inputs, loaded } from './test-utils';
import type { InstrumentRef } from './index';

/**
 * Exit beyond the expected move at entry (options brief v2 §10 item 10, ADR
 * 0053): the move is captured when Entry is decided and fixed with the cycle.
 */

const INSTRUMENTS = new Map<string, InstrumentRef>([
  [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
]);
const MOVE = 0.02;

function signals(dates: string[], move = MOVE): Map<string, OptionSignal[]> {
  const nulls = Object.fromEntries(
    OPTION_SIGNAL_FIELDS.map((f) => [f, null]),
  ) as OptionSignalValues;
  return new Map([
    [
      SPY,
      dates.map((asOfDate) => ({
        asOfDate,
        values: { ...nulls, expected_move_5d_pct: move, expected_move_1d_pct: move / Math.sqrt(5) },
        source: 'recorded' as const,
        ivHistoryDays: 252,
      })),
    ],
  ]);
}

function moveExit(side: 'either' | 'gain' | 'loss'): StrategyDefinition {
  const def = riskAtrTrend();
  def.exit.rules = [{ kind: 'expectedMove', id: 'em', horizon: 5, multiple: '1', side }];
  def.exit.condition.children = [];
  return def;
}

const bars = spyBars();
const run = (def: StrategyDefinition, options?: Map<string, OptionSignal[]>) => {
  const data = loaded({ [SPY]: bars });
  if (options) data.options = options;
  return simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs('2023-11-01', '2025-06-30'),
    data,
  });
};
const dates = bars.map((b) => b.start.slice(0, 10));

describe('the expected-move band', () => {
  const band = expectedMoveBand(new Decimal(100), new Decimal(0.048), '1');
  it('is entry × (1 ± multiple × move)', () => {
    expect(band.lower.toString()).toBe('95.2');
    expect(band.upper.toString()).toBe('104.8');
    expect(expectedMoveBand(new Decimal(100), new Decimal(0.02), '1.5').upper.toString()).toBe(
      '103',
    );
  });
  it('fires either way, or only on a gain or a loss for the position', () => {
    const up = new Decimal(105);
    const down = new Decimal(95);
    expect(expectedMoveHit(up, band, 'either', true)).toBe(true);
    expect(expectedMoveHit(down, band, 'either', true)).toBe(true);
    expect(expectedMoveHit(new Decimal(100), band, 'either', true)).toBe(false);
    expect(expectedMoveHit(up, band, 'gain', true)).toBe(true);
    expect(expectedMoveHit(down, band, 'gain', true)).toBe(false);
    expect(expectedMoveHit(down, band, 'loss', true)).toBe(true);
    // A short gains when the price falls.
    expect(expectedMoveHit(down, band, 'gain', false)).toBe(true);
    expect(expectedMoveHit(up, band, 'loss', false)).toBe(true);
    expect(expectedMoveHit(up, band, 'gain', false)).toBe(false);
  });
});

describe('a back test with the expected-move exit', () => {
  it('exits on the first daily close beyond the move captured at entry', () => {
    const r = run(moveExit('either'), signals(dates));
    const exits = r.trades.filter((t) => t.exitReason === 'expected_move');
    expect(exits.length).toBeGreaterThan(0);
    for (const t of exits) {
      const m = t.expectedMove!;
      expect(Number(m.movePct)).toBeCloseTo(MOVE, 9);
      expect(Number(m.upper)).toBeCloseTo(Number(m.entryPrice) * (1 + MOVE), 3);
      expect(Number(m.lower)).toBeCloseTo(Number(m.entryPrice) * (1 - MOVE), 3);
      // Decided on the close before the exit fill; no earlier close was beyond the band.
      const fill = bars.findIndex((b) => b.start === t.exitTime);
      const decided = bars[fill - 1]!.close.toNumber();
      expect(decided > Number(m.upper) || decided < Number(m.lower)).toBe(true);
      const entry = bars.findIndex((b) => b.start === t.entryTime);
      for (const b of bars.slice(entry, fill - 1)) {
        expect(b.close.toNumber()).toBeLessThanOrEqual(Number(m.upper));
        expect(b.close.toNumber()).toBeGreaterThanOrEqual(Number(m.lower));
      }
    }
    expect(r.assumptions.some((a) => a.includes('expected-move exit'))).toBe(true);
  });

  it('keeps the move from entry even when later signals change', () => {
    const changing = signals(dates);
    const list = changing.get(SPY)!;
    list.forEach((s, i) => (s.values.expected_move_5d_pct = 0.01 + (i % 7) * 0.005));
    const r = run(moveExit('either'), changing);
    const withMove = r.trades.filter((x) => x.expectedMove);
    expect(withMove.length).toBeGreaterThan(1);
    for (const t of withMove) {
      const signalDay = bars.findIndex((b) => b.start === t.entryTime) - 1;
      expect(Number(t.expectedMove!.movePct)).toBeCloseTo(
        list[signalDay]!.values.expected_move_5d_pct!,
        9,
      );
    }
  });

  it('exits only upward on "a gain only" for a long', () => {
    const r = run(moveExit('gain'), signals(dates));
    const gains = r.trades.filter((x) => x.exitReason === 'expected_move');
    expect(gains.length).toBeGreaterThan(0);
    for (const t of gains) {
      const fill = bars.findIndex((b) => b.start === t.exitTime);
      expect(bars[fill - 1]!.close.toNumber()).toBeGreaterThan(Number(t.expectedMove!.upper));
    }
  });

  it('says so, and never exits on it, when no options signal was recorded at entry', () => {
    const r = run(moveExit('either'));
    expect(r.trades.some((t) => t.exitReason === 'expected_move')).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain('expected_move_unset');
  });
});
