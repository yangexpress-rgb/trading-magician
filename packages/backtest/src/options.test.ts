import { regularSession, tradingDays, type Bar, type ContractListEntry } from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import { OPTIONS_BACKTEST_LABEL, type OptionsBacktestData } from './options';
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
 * Options in back tests (options brief v0.2 §11, ADR 0123): a long call
 * picked point in time from the contract list, filled at the next open ± the
 * premium slippage, × 100 a contract; option-style exits; expiry day (A6);
 * no lookahead (A9).
 */

const FROM = '2024-03-01';
const days = tradingDays(FROM, '2024-06-30');
const day = (i: number) => days[i]!;

/** A contract's daily bars: [day index, open, close]. */
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

const contract = (symbol: string, expiry: string, strike: string): ContractListEntry => ({
  symbol,
  expiry,
  right: 'call',
  strike,
  multiplier: '100',
  standard: true,
});

function longCall(
  rules: NonNullable<ReturnType<typeof strategy>['exit']['rules']> = [],
  quantity = '1',
  targetDte = 30,
) {
  const option = {
    right: 'call' as const,
    strikeRule: { type: 'atm' as const },
    expiryRule: { targetDte, minDte: 1 },
  };
  const def = strategy(
    compare(close(A), 'gt', constant('99.5')),
    [leg('Buy call', { option, quantity: { type: 'units', value: quantity, rounding: 'down' } })],
    compare(close(A), 'lt', constant('0')),
    [leg('Sell call', { side: 'sell', option })],
  );
  def.exit.rules = rules;
  return def;
}

const run = (
  def: ReturnType<typeof strategy>,
  data: OptionsBacktestData,
  underlying: number[],
  to = day(40),
  needed?: string[],
) =>
  simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs(FROM, to),
    data: loaded({ [A]: closes(FROM, underlying) }),
    optionsData: data,
    ...(needed ? { onOptionBarsNeeded: (s) => needed.push(...s) } : {}),
  });

// Entry is decided on day 1, Monday 2024-03-04: Friday 2024-04-05 is 32 days
// out and Friday 2024-03-29 is 25, so the 30-day target picks 2024-04-05.
const E28 = '2024-03-29';
const E35 = '2024-04-05';
/** 99 then 100s: Entry fires on day 1's close and fills at day 2's open. */
const flat = (n: number, v = 100) => [99, ...Array.from({ length: n - 1 }, () => v)];

describe('options back tests (ADR 0123)', () => {
  it('buys the contract nearest the target, × 100, and exits on the premium target', () => {
    const c100 = contract('ZZZ240405C00100000', E35, '100');
    const data: OptionsBacktestData = {
      contracts: new Map([
        [
          A,
          [
            c100,
            contract('ZZZ240405C00105000', E35, '105'),
            contract('ZZZ240329C00100000', E28, '100'),
          ],
        ],
      ]),
      bars: new Map([
        [
          c100.symbol,
          contractBars([
            [0, 2, 2],
            [1, 2, 2],
            [2, 2, 2.1],
            [3, 2.5, 2.8],
            [4, 3.1, 3.2],
            [5, 3.3, 3.4],
          ]),
        ],
        ['ZZZ240405C00105000', contractBars([[0, 1, 1]])],
        ['ZZZ240329C00100000', contractBars([[0, 1.8, 1.8]])],
      ]),
      slippagePct: '5',
    };
    const result = run(longCall([{ kind: 'optionTarget', id: 't', pct: '50' }]), data, flat(10));
    expect(result.warnings.map((w) => w.message)).toContain(OPTIONS_BACKTEST_LABEL);
    const [trade] = result.trades;
    expect(trade?.status).toBe('closed');
    expect(trade?.exitReason).toBe('option_target');
    const [buy, sell] = trade!.legs;
    expect(buy).toMatchObject({ symbol: c100.symbol, averagePrice: '2.1' }); // day 2 open 2.00 + 5%
    // Target: close 3.20 ≥ 2.10 × 1.5 on day 4; sold at day 5's open 3.30 − 5%.
    expect(sell).toMatchObject({ symbol: c100.symbol, averagePrice: '3.135' });
    // Gross at the opens: (3.30 − 2.00) × 100 = $130; net after slippage (3.135 − 2.10) × 100.
    expect(trade?.grossPnl).toBe('130');
    expect(trade?.netPnl).toBe('103.5');
  });

  it('settles an untraded out-of-the-money contract at 0 on expiry: −premium, Expired worthless (A6)', () => {
    const near = contract('ZZZ240308C00100000', '2024-03-08', '100');
    const data: OptionsBacktestData = {
      contracts: new Map([[A, [near]]]),
      bars: new Map([
        [
          near.symbol,
          contractBars([
            [0, 2, 2],
            [1, 2, 2],
            [2, 2, 1.5],
            [3, 1, 0.8],
          ]),
        ],
      ]),
      slippagePct: '0',
    };
    const result = run(longCall([], '1', 3), data, [99, 100, 99, 98, 97, 96, 95, 95]);
    const [trade] = result.trades;
    expect(trade?.exitReason).toBe('expired_worthless');
    expect(trade?.legs[0]?.averagePrice).toBe('2');
    expect(trade?.netPnl).toBe('-200');
  });

  it('closes a contract still held on its expiry day at that day’s close: Closed before expiry (A6)', () => {
    const near = contract('ZZZ240308C00100000', '2024-03-08', '100');
    const data: OptionsBacktestData = {
      contracts: new Map([[A, [near]]]),
      bars: new Map([
        [
          near.symbol,
          contractBars([
            [0, 2, 2],
            [1, 2, 2],
            [2, 2, 1.5],
            [5, 0.6, 0.5],
          ]),
        ],
      ]),
      slippagePct: '0',
    };
    const result = run(longCall([], '1', 3), data, flat(8));
    const [trade] = result.trades;
    expect(trade?.exitReason).toBe('closed_before_expiry');
    expect(trade?.exitTime?.slice(0, 10)).toBe('2024-03-08');
    expect(trade?.netPnl).toBe('-150');
  });

  it('counts premium × 100 as the order value: 3 contracts at 2.00 is $600 (A7)', () => {
    const c = contract('ZZZ240405C00100000', E35, '100');
    const data: OptionsBacktestData = {
      contracts: new Map([[A, [c]]]),
      bars: new Map([
        [
          c.symbol,
          contractBars([
            [0, 2, 2],
            [1, 2, 2],
            [2, 2, 2],
          ]),
        ],
      ]),
      slippagePct: '0',
    };
    const refused = longCall([], '3');
    refused.risk.maxOrderNotional = '599';
    expect(run(refused, data, flat(5)).trades.filter((t) => t.legs.length > 0)).toHaveLength(0);
    const allowed = longCall([], '3');
    allowed.risk.maxOrderNotional = '600';
    const [trade] = run(allowed, data, flat(5)).trades;
    expect(trade?.legs[0]).toMatchObject({ quantity: '3', averagePrice: '2' });
  });

  it('never picks a contract that had not traded by the decision date (A9)', () => {
    const listed = contract('ZZZ240405C00100000', E35, '100');
    // Exactly at the money and a closer expiry, but its first trade is two days later.
    const later = contract('ZZZ240401C00100000', '2024-04-01', '100');
    const base: OptionsBacktestData = {
      contracts: new Map([[A, [listed]]]),
      bars: new Map([
        [
          listed.symbol,
          contractBars([
            [0, 2, 2],
            [1, 2, 2],
            [2, 2, 2],
          ]),
        ],
      ]),
      slippagePct: '0',
    };
    const before = run(longCall(), base, flat(6));
    const withLater: OptionsBacktestData = {
      ...base,
      contracts: new Map([[A, [listed, later]]]),
      bars: new Map([
        ...base.bars,
        [
          later.symbol,
          contractBars([
            [2, 9, 9],
            [3, 9, 9],
          ]),
        ],
      ]),
    };
    const after = run(longCall(), withLater, flat(6));
    expect(after.trades[0]?.legs[0]?.symbol).toBe(listed.symbol);
    expect(after.trades).toEqual(before.trades);
    // Changing the contract's bars after the run's end changes nothing either.
    const future: OptionsBacktestData = {
      ...base,
      bars: new Map([
        [listed.symbol, [...base.bars.get(listed.symbol)!, ...contractBars([[30, 50, 50]])]],
      ]),
    };
    expect(run(longCall(), future, flat(6), day(5)).trades).toEqual(
      run(longCall(), base, flat(6), day(5)).trades,
    );
  });

  it('asks for the bars of a pick it has none for, and places nothing for it', () => {
    const c = contract('ZZZ240405C00100000', E35, '100');
    const needed: string[] = [];
    const result = run(
      longCall(),
      { contracts: new Map([[A, [c]]]), bars: new Map(), slippagePct: '5' },
      flat(5),
      day(4),
      needed,
    );
    expect(needed).toContain(c.symbol);
    expect(result.trades.filter((t) => t.status !== 'aborted')).toHaveLength(0);
  });
});

describe('options combos in back tests (ADR 0123 Phase O2)', () => {
  const callAt = (symbol: string, strike: string) => contract(symbol, E35, strike);
  const C105 = callAt('ZZZ240405C00105000', '105');
  const C110 = callAt('ZZZ240405C00110000', '110');
  // Day 0–2 the short 105 call at 1.50, the long 110 call at 0.50: a 1.00 credit.
  // From day 3 they fade to 0.60 and 0.10: half the credit kept.
  const data: OptionsBacktestData = {
    contracts: new Map([[A, [C105, C110, callAt('ZZZ240405C00100000', '100')]]]),
    bars: new Map([
      [
        C105.symbol,
        contractBars([
          [0, 1.5, 1.5],
          [1, 1.5, 1.5],
          [2, 1.5, 1.5],
          [3, 0.6, 0.6],
          [4, 0.6, 0.6],
          [5, 0.6, 0.6],
        ]),
      ],
      [
        C110.symbol,
        contractBars([
          [0, 0.5, 0.5],
          [1, 0.5, 0.5],
          [2, 0.5, 0.5],
          [3, 0.1, 0.1],
          [4, 0.1, 0.1],
          [5, 0.1, 0.1],
        ]),
      ],
    ]),
    slippagePct: '0',
  };

  function vertical(
    sets: string,
    rules: NonNullable<ReturnType<typeof strategy>['exit']['rules']> = [],
  ) {
    const opt = (pct: number) => ({
      right: 'call' as const,
      strikeRule: { type: 'moneynessPct' as const, pct },
      expiryRule: { targetDte: 30, minDte: 1 },
    });
    const units = { type: 'units' as const, value: sets, rounding: 'down' as const };
    const def = strategy(
      compare(close(A), 'gt', constant('99.5')),
      [
        leg('Sell 105', { side: 'sell_short', option: opt(5), quantity: units }),
        leg('Buy 110', { option: opt(10), quantity: units }),
      ],
      compare(close(A), 'lt', constant('0')),
      [
        leg('Cover 105', { side: 'buy_to_cover', option: opt(5), quantity: units }),
        leg('Sell 110', { side: 'sell', option: opt(10), quantity: units }),
      ],
    );
    def.exit.rules = rules;
    return def;
  }

  it('checks a credit vertical as a whole on its max loss: 2 sets × (5 − 1.00) × 100 = $800 (A3, A7)', () => {
    const refused = vertical('2');
    refused.risk.maxOrderNotional = '799';
    const none = run(refused, data, flat(6));
    expect(none.trades.filter((t) => t.legs.length > 0)).toHaveLength(0);
    const allowed = vertical('2');
    allowed.risk.maxOrderNotional = '800';
    const [trade] = run(allowed, data, flat(6)).trades;
    expect(trade?.legs.map((l) => [l.symbol, l.side, l.quantity, l.averagePrice])).toEqual([
      [C105.symbol, 'sell_short', '2', '1.5'],
      [C110.symbol, 'buy', '2', '0.5'],
    ]);
  });

  it('reads the profit target on the combo as a whole, and each Exit leg closes its own contract', () => {
    const [trade] = run(
      vertical('1', [{ kind: 'optionTarget', id: 't', pct: '50' }]),
      data,
      flat(8),
    ).trades;
    expect(trade?.exitReason).toBe('option_target');
    const exits = trade!.legs.slice(2);
    expect(exits.map((l) => [l.symbol, l.side, l.averagePrice])).toEqual([
      [C105.symbol, 'buy_to_cover', '0.6'],
      [C110.symbol, 'sell', '0.1'],
    ]);
    // Took in 1.00, paid 0.50 to close: $50.
    expect(trade?.netPnl).toBe('50');
  });
});
