import type { Expr, PositionExpr } from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import {
  A,
  B,
  INSTRUMENTS,
  close,
  closes,
  compare,
  constant,
  dailyBars,
  inputs,
  leg,
  loaded,
  strategy,
} from './test-utils';

const FROM = '2024-03-04';

/** Buys 10 DEMO-A when the close rises above 100; sells them when it falls back below. */
const crossover = () =>
  strategy(
    compare(close(), 'gt', constant('100')),
    [leg('buy-a')],
    compare(close(), 'lt', constant('100')),
    [leg('sell-a', { side: 'sell' })],
  );

describe('simulate: worked examples', () => {
  it('fills at the next open with slippage and books the cycle (hand-computed)', () => {
    const bars = dailyBars(FROM, [
      [99, 99, 99, 99],
      [101, 101, 101, 101], // Entry turns true at this close
      [100, 103, 99, 102], // buy fills at the open: 100 × 1.001 = 100.10
      [98, 98, 98, 98], // Exit turns true at this close
      [110, 110, 99, 99], // sell fills at the open: 110 × 0.999 = 109.89
    ]);
    const r = simulate({
      definition: crossover(),
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-08', { slippageBps: '10' }),
      data: loaded({ [A]: bars }),
    });

    expect(r.fills.map((f) => [f.time, f.side, f.quantity, f.price, f.slippage])).toEqual([
      [bars[2]?.start, 'buy', '10', '100.1', '1'],
      [bars[4]?.start, 'sell', '10', '109.89', '1.1'],
    ]);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({
      cycle: 1,
      status: 'closed',
      entryTime: bars[2]?.start,
      exitTime: bars[4]?.start,
      grossPnl: '100',
      costs: '2.1',
      netPnl: '97.9',
      returnPct: '9.78',
    });
    // 100000 − 1001 cash, then valued at each close.
    expect(r.equity.map((p) => p.equity)).toEqual([
      '100000',
      '100000',
      '100019',
      '99979',
      '100097.9',
    ]);
    expect(r.equity[2]).toMatchObject({
      grossExposure: '1020',
      netExposure: '1020',
      cash: '98999',
    });
    expect(r.metrics).toMatchObject({
      initialCapital: '100000',
      finalEquity: '100097.9',
      netReturnPct: '0.1',
      grossReturnPct: '0.1',
      maxDrawdownPct: '0.04',
      winRatePct: '100',
      profitFactor: null,
      sharpe: null,
      cycles: 1,
      closedCycles: 1,
      orders: 2,
      fills: 2,
      slippage: '2.1',
      commission: '0',
      borrow: '0',
    });
    expect(r.contributions).toEqual([
      {
        instrumentId: A,
        symbol: 'DEMO-A',
        legs: ['buy-a', 'sell-a'],
        grossPnl: '100',
        costs: '2.1',
        netPnl: '97.9',
        fills: 2,
      },
    ]);
    expect(r.engineVersion).toBe('engine@1');
    expect(r.dataVersions).toEqual(['test@1']);
  });

  it('does not fire an on-transition Entry that is already true at the start', () => {
    const r = simulate({
      definition: crossover(),
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-08'),
      data: loaded({ [A]: closes(FROM, [101, 102, 103, 104, 105]) }),
    });
    expect(r.fills).toEqual([]);
    expect(r.metrics.finalEquity).toBe('100000');
  });

  it('charges commission with a minimum per fill', () => {
    const r = simulate({
      definition: crossover(),
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-08', {
        slippageBps: '0',
        commissionPerShare: '0.01',
        commissionMin: '1',
      }),
      data: loaded({ [A]: closes(FROM, [99, 101, 101, 99, 99]) }),
    });
    // 10 shares × 0.01 = 0.10, so the 1.00 minimum applies to both fills.
    expect(r.fills.map((f) => f.commission)).toEqual(['1', '1']);
    expect(r.trades[0]).toMatchObject({ grossPnl: '-20', costs: '2', netPnl: '-22' });
    expect(r.metrics).toMatchObject({ commission: '2', winRatePct: '0', profitFactor: '0' });
  });

  it('charges borrow on a short at each close it is held', () => {
    const def = strategy(
      compare(close(), 'lt', constant('100')),
      [
        leg('short-a', {
          side: 'sell_short',
          quantity: { type: 'units', value: '50', rounding: 'down' },
        }),
      ],
      compare(close(), 'gt', constant('100')),
      [
        leg('cover-a', {
          side: 'buy_to_cover',
          quantity: { type: 'units', value: '50', rounding: 'down' },
        }),
      ],
    );
    const r = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-11', { slippageBps: '0', borrowRatePct: '2.52' }),
      data: loaded({ [A]: closes(FROM, [101, 99, 99, 99, 101, 101]) }),
    });
    // Short 50 at 99 on day 3; held at the closes of days 3, 4 and 5 (99, 99, 101);
    // covered at 101 on day 6. Daily borrow = 50 × close × 2.52% / 252.
    const borrow = [99, 99, 101].reduce((a, px) => a + (50 * px * 0.0252) / 252, 0);
    expect(r.fills.map((f) => [f.side, f.price])).toEqual([
      ['sell_short', '99'],
      ['buy_to_cover', '101'],
    ]);
    expect(Number(r.metrics.borrow)).toBeCloseTo(borrow, 2);
    expect(Number(r.trades[0]?.netPnl)).toBeCloseTo(-100 - borrow, 2);
    expect(r.trades[0]?.grossPnl).toBe('-100');
  });

  it('fills a limit at the limit only once a bar trades through it', () => {
    const def = crossover();
    def.entry.orders = [
      leg('buy-a', { orderType: 'limit', limitPrice: constant('100.5'), timeInForce: 'gtc' }),
    ];
    const bars = dailyBars(FROM, [
      [99, 99, 99, 99],
      [101, 101, 101, 101],
      [101, 102, 100.8, 101.5], // never reaches 100.5
      [101, 101.5, 100, 101], // trades through: fills at 100.5
      [101, 101, 101, 101],
    ]);
    const r = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-08'),
      data: loaded({ [A]: bars }),
    });
    expect(r.fills.map((f) => [f.time, f.price, f.slippage])).toEqual([
      [bars[3]?.start, '100.5', '0'],
    ]);
    expect(r.trades[0]?.status).toBe('open');
    expect(r.warnings.map((w) => w.code)).toContain('open_at_end');
  });

  it('spreads a fill over several bars under the volume cap', () => {
    const def = crossover();
    def.entry.orders = [
      leg('buy-a', {
        quantity: { type: 'units', value: '25', rounding: 'down' },
        timeInForce: 'gtc',
      }),
    ];
    const r = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-08', { slippageBps: '0', maxVolumePct: '10' }),
      data: loaded({
        [A]: dailyBars(
          FROM,
          [99, 101, 101, 101, 101].map((p) => [p, p, p, p, 100] as const),
        ),
      }),
    });
    expect(r.fills.map((f) => f.quantity)).toEqual(['10', '10', '5']);
    expect(r.warnings.map((w) => w.code)).toContain('volume_cap');
  });

  it('rejects an order above the maximum order size and aborts the cycle', () => {
    const def = crossover();
    def.entry.orders = [
      leg('buy-a', { quantity: { type: 'units', value: '200', rounding: 'down' } }),
    ];
    const r = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-08'),
      data: loaded({ [A]: closes(FROM, [99, 101, 101, 101, 101]) }),
    });
    expect(r.fills).toEqual([]);
    expect(r.trades.map((t) => t.status)).toEqual(['aborted']);
    expect(r.warnings.map((w) => w.code)).toContain('risk_order_size');
    expect(r.metrics.cycles).toBe(0);
  });

  it('cancels a market order whose open gaps beyond the price collar', () => {
    const r = simulate({
      definition: crossover(),
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-08'),
      data: loaded({ [A]: closes(FROM, [99, 101, 110, 110, 110]) }),
    });
    expect(r.fills).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain('collar_cancel');
  });

  it('flattens the filled leg of a pair when the other leg times out', () => {
    const def = strategy(
      compare(close(A), 'gt', constant('100')),
      [
        leg('long-a'),
        // A limit far below the market never fills.
        leg('short-b', {
          instrumentId: B,
          side: 'sell_short',
          orderType: 'limit',
          limitPrice: constant('200'),
          timeInForce: 'gtc',
        }),
      ],
      compare(close(A), 'lt', constant('90')),
      [leg('close-a', { side: 'close' }), leg('close-b', { instrumentId: B, side: 'close' })],
    );
    def.execution.onLegFailure = 'flatten_filled';
    delete def.risk.priceCollarPct;
    const r = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-08', { slippageBps: '0' }),
      data: loaded({
        [A]: closes(FROM, [99, 101, 102, 103, 104]),
        [B]: closes(FROM, [50, 50, 50, 50, 50]),
      }),
    });
    expect(r.fills.map((f) => [f.legId, f.side, f.price])).toEqual([
      ['long-a', 'buy', '102'],
      ['flatten-' + A, 'sell', '103'],
    ]);
    expect(r.trades[0]).toMatchObject({ status: 'closed', netPnl: '10' });
    expect(r.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['leg_timeout', 'leg_failed', 'flattened']),
    );
  });

  it('runs a market-neutral pair through Entry and Exit', () => {
    const spread = (): Expr => ({
      kind: 'calc',
      id: 'spread',
      op: 'sub',
      args: [close(A), close(B)],
    });
    const def = strategy(
      compare(spread(), 'gt', constant('5')),
      [leg('short-a', { side: 'sell_short' }), leg('long-b', { instrumentId: B })],
      compare(spread(), 'lt', constant('1')),
      [leg('cover-a', { side: 'buy_to_cover' }), leg('sell-b', { instrumentId: B, side: 'sell' })],
    );
    const r = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-11', { slippageBps: '0', borrowRatePct: '0' }),
      data: loaded({
        [A]: closes(FROM, [100, 103, 103, 101, 100, 100]),
        [B]: closes(FROM, [100, 97, 97, 99.5, 99.5, 99.5]),
      }),
    });
    // Enter at 103 / 97 (spread 6), exit at 100 / 99.5 (spread 0.5).
    // Short A: +30; long B: +25.
    expect(r.trades[0]).toMatchObject({ status: 'closed', grossPnl: '55', netPnl: '55' });
    expect(r.contributions.map((c) => [c.symbol, c.netPnl])).toEqual([
      ['DEMO-A', '30'],
      ['DEMO-B', '25'],
    ]);
    expect(Number(r.equity[2]?.netExposure)).toBeCloseTo(-60, 6);
  });
});

describe('simulate: properties', () => {
  it('is deterministic', () => {
    const definition = crossover();
    const run = () =>
      simulate({
        definition,
        instruments: INSTRUMENTS,
        inputs: inputs('2024-03-04', '2024-03-08'),
        data: loaded({ [A]: closes(FROM, [99, 101, 102, 98, 99]) }),
      });
    expect(run()).toEqual(run());
  });

  it('values with Decimal arithmetic, not floats', () => {
    expect(new Decimal('0.1').plus('0.2').toString()).toBe('0.3');
  });
});

describe('simulate: position values', () => {
  const gain = (field: PositionExpr['field'] = 'gain_pct'): PositionExpr => ({
    kind: 'position',
    id: `pos-${field}`,
    instrumentId: A,
    field,
    interval: '1d',
    adjustment: 'split_and_dividend',
    session: 'regular',
  });

  it('sells once the close is 5% above the entry fill (take-profit)', () => {
    const bars = dailyBars(FROM, [
      [99, 99, 99, 99],
      [101, 101, 101, 101], // Entry turns true at this close
      [100, 103, 99, 102], // buy fills at the open: 100; gain at close 2%
      [102, 105, 101, 104.9], // gain 4.9%: not yet
      [105, 106, 104, 105], // gain 5%: Exit triggers at this close
      [107, 108, 106, 107], // sell fills at the open: 107
    ]);
    const r = simulate({
      definition: strategy(
        compare(close(), 'gt', constant('100')),
        [leg('buy-a')],
        compare(gain(), 'gte', constant('5')),
        [leg('sell-a', { side: 'sell' })],
      ),
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-11', { slippageBps: '0' }),
      data: loaded({ [A]: bars }),
    });
    expect(r.fills.map((f) => [f.time, f.side, f.price])).toEqual([
      [bars[2]?.start, 'buy', '100'],
      [bars[5]?.start, 'sell', '107'],
    ]);
    expect(r.trades[0]).toMatchObject({ status: 'closed', grossPnl: '70' });
    const exitBars = r.conditions!.exit.bars.map((b) => [b.time, b.truth]);
    expect(exitBars).toEqual([
      [bars[2]?.end, false],
      [bars[3]?.end, false],
      [bars[4]?.end, true],
    ]);
  });

  it('prices a limit Exit from the entry fill', () => {
    const bars = dailyBars(FROM, [
      [99, 99, 99, 99],
      [101, 101, 101, 101],
      [100, 103, 99, 102], // buy fills at 100; limit sell placed at 105
      [103, 104, 102, 103], // high 104: no fill
      [104, 106, 103, 105], // trades through 105: fills at the limit
    ]);
    const r = simulate({
      definition: strategy(
        compare(close(), 'gt', constant('100')),
        [leg('buy-a')],
        compare(gain('quantity'), 'gt', constant('0')),
        [
          leg('sell-a', {
            side: 'sell',
            orderType: 'limit',
            timeInForce: 'gtc',
            limitPrice: {
              kind: 'calc',
              id: 'lp',
              op: 'mul',
              args: [gain('entry_price'), constant('1.05')],
            },
          }),
        ],
      ),
      instruments: INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-08', { slippageBps: '0' }),
      data: loaded({ [A]: bars }),
    });
    expect(r.fills.map((f) => [f.time, f.side, f.price])).toEqual([
      [bars[2]?.start, 'buy', '100'],
      [bars[4]?.start, 'sell', '105'],
    ]);
  });
});
