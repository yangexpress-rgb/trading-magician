import { regularSession, tradingDays, type Bar, type ContractListEntry } from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import type { OptionsBacktestData } from './options';
import {
  A,
  INSTRUMENTS,
  closes,
  compare,
  close,
  constant,
  inputs,
  leg,
  loaded,
  strategy,
} from './test-utils';

/**
 * Phase O3 in back tests (ADR 0123): covered calls, cash-secured puts and the
 * roll rule, on the same contract list and daily bars as O1 and O2.
 */

const FROM = '2024-03-01';
const days = tradingDays(FROM, '2024-06-30');
const day = (i: number) => days[i]!;

function contractBars(rows: readonly (readonly [number, number, number])[]): Bar[] {
  return rows.map(([i, o, c]) => {
    const s = regularSession(day(i))!;
    return {
      start: s.open,
      end: s.close,
      open: new Decimal(o),
      high: new Decimal(Math.max(o, c)),
      low: new Decimal(Math.min(o, c)),
      close: new Decimal(c),
      volume: new Decimal(100),
    };
  });
}

const entry = (
  symbol: string,
  expiry: string,
  strike: string,
  right: 'call' | 'put',
): ContractListEntry => ({ symbol, expiry, right, strike, multiplier: '100', standard: true });

const E35 = '2024-04-05';
const E42 = '2024-04-12';
const flat = (n: number, v = 100) => [99, ...Array.from({ length: n - 1 }, () => v)];
const units = (value: string) => ({ type: 'units' as const, value, rounding: 'down' as const });
const spec = (right: 'call' | 'put', pct = 5) => ({
  right,
  strikeRule: { type: 'moneynessPct' as const, pct },
  expiryRule: { targetDte: 30, minDte: 1 },
});

const run = (
  def: ReturnType<typeof strategy>,
  data: OptionsBacktestData,
  n: number,
  to = day(12),
) =>
  simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs(FROM, to, { slippageBps: 0 }),
    data: loaded({ [A]: closes(FROM, flat(n)) }),
    optionsData: data,
  });

// Day 0–2 the 105 call and the 95 put at 1.50; from day 3 both fade to 0.60.
const C105 = entry('ZZZ240405C00105000', E35, '105', 'call');
const P95 = entry('ZZZ240405P00095000', E35, '95', 'put');
const fading = contractBars([
  [0, 1.5, 1.5],
  [1, 1.5, 1.5],
  [2, 1.5, 1.5],
  [3, 0.6, 0.6],
  [4, 0.6, 0.6],
  [5, 0.6, 0.6],
]);
const data: OptionsBacktestData = {
  contracts: new Map([[A, [C105, P95]]]),
  bars: new Map([
    [C105.symbol, fading],
    [P95.symbol, fading],
  ]),
  slippagePct: '0',
};

describe('covered calls and cash-secured puts in back tests (O3)', () => {
  function coveredCall(withShares = true) {
    const def = strategy(
      compare(close(A), 'gt', constant('99.5')),
      [
        ...(withShares ? [leg('Buy shares', { quantity: units('100') })] : []),
        leg('Sell call', { side: 'sell_short', option: spec('call'), quantity: units('1') }),
      ],
      compare(close(A), 'lt', constant('0')),
      [
        leg('Cover call', { side: 'buy_to_cover', option: spec('call'), quantity: units('1') }),
        ...(withShares ? [leg('Sell shares', { side: 'sell', quantity: units('100') })] : []),
      ],
    );
    def.exit.rules = [{ kind: 'optionTarget', id: 't', pct: '50' }];
    return def;
  }

  it('sells the call on the shares bought, and keeps the premium when it fades', () => {
    const [trade] = run(coveredCall(), data, 8).trades;
    expect(trade?.exitReason).toBe('option_target');
    expect(trade?.legs.map((l) => [l.symbol, l.side, l.quantity, l.averagePrice])).toEqual([
      ['DEMO-A', 'buy', '100', '100'],
      [C105.symbol, 'sell_short', '1', '1.5'],
      [C105.symbol, 'buy_to_cover', '1', '0.6'],
      ['DEMO-A', 'sell', '100', '100'],
    ]);
    // The shares are flat; the call took in 1.50 and paid 0.60 back: $90.
    expect(trade?.netPnl).toBe('90');
  });

  it('refuses a call with no shares to cover it', () => {
    const result = run(coveredCall(false), data, 8);
    expect(result.trades.filter((t) => t.legs.length > 0)).toHaveLength(0);
  });

  it('counts a cash-secured put at its strike less the premium: (95 − 1.50) × 100 = $9,350', () => {
    const put = (limit: string) => {
      const def = strategy(
        compare(close(A), 'gt', constant('99.5')),
        [leg('Sell put', { side: 'sell_short', option: spec('put'), quantity: units('1') })],
        compare(close(A), 'lt', constant('0')),
        [leg('Cover put', { side: 'buy_to_cover', option: spec('put'), quantity: units('1') })],
      );
      def.exit.rules = [{ kind: 'optionTarget', id: 't', pct: '50' }];
      def.risk.maxOrderNotional = limit;
      return def;
    };
    expect(run(put('9349'), data, 8).trades.filter((t) => t.legs.length > 0)).toHaveLength(0);
    const [trade] = run(put('9350'), data, 8).trades;
    expect(trade?.legs.map((l) => [l.symbol, l.side, l.averagePrice])).toEqual([
      [P95.symbol, 'sell_short', '1.5'],
      [P95.symbol, 'buy_to_cover', '0.6'],
    ]);
    expect(trade?.netPnl).toBe('90');
  });
});

describe('the roll rule in back tests (O3)', () => {
  // Entry on day 1 (Mon Mar 4) picks Apr 5, 32 days out. At 25 days to expiry
  // (Mon Mar 11, day 6) the roll closes it at that day's close and picks again:
  // 30 days from Mar 11 is the Apr 12 expiry, bought at day 7's open.
  const A100 = entry('ZZZ240405C00100000', E35, '100', 'call');
  const B100 = entry('ZZZ240412C00100000', E42, '100', 'call');
  const rollData: OptionsBacktestData = {
    contracts: new Map([[A, [A100, B100]]]),
    bars: new Map([
      [A100.symbol, contractBars(Array.from({ length: 10 }, (_, i) => [i, 2, 2] as const))],
      [B100.symbol, contractBars(Array.from({ length: 10 }, (_, i) => [i, 3, 3] as const))],
    ]),
    slippagePct: '0',
  };
  const atm = {
    right: 'call' as const,
    strikeRule: { type: 'atm' as const },
    expiryRule: { targetDte: 30, minDte: 1 },
  };

  it('closes the contract and opens a later one in the same cycle', () => {
    const def = strategy(
      compare(close(A), 'gt', constant('99.5')),
      [leg('Buy call', { option: atm, quantity: units('1') })],
      compare(close(A), 'lt', constant('0')),
      [leg('Sell call', { side: 'sell', option: atm, quantity: units('1') })],
    );
    def.exit.rules = [{ kind: 'optionRoll', id: 'r', days: 25 }];
    const result = run(def, rollData, 10, day(9));
    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade?.legs.map((l) => [l.symbol, l.side, l.averagePrice])).toEqual([
      // Entry legs first (the roll's opening is an Entry leg), then the roll's close.
      [A100.symbol, 'buy', '2'],
      [B100.symbol, 'buy', '3'],
      [A100.symbol, 'sell', '2'],
    ]);
    expect(result.warnings.map((w) => w.code)).toContain('options_rolled');
  });
});
