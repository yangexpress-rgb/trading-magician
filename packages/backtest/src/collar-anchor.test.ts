import {
  createDefinition,
  regularSession,
  sequentialIds,
  type Bar,
  type MarketExpr,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { seriesKey, type LoadedData } from './data';
import { simulate } from './engine';
import { A, INSTRUMENTS, compare, constant, inputs, leg, type Row } from './test-utils';

/**
 * The price collar's anchor in back tests (N325, ADR 0113): never a price from
 * an earlier session. Within the session an order was decided in, the anchor is
 * still the last close when it was decided (unchanged); in any later session it
 * is that session's first price the order sees (its release snapshot).
 */

const FIVE = 5 * 60_000;

/** 5-minute bars of one session, starting `from` bars after the open. */
function fiveMinute(date: string, rows: readonly Row[], from = 0): Bar[] {
  const session = regularSession(date);
  if (!session) throw new Error(`${date} is not a trading day`);
  const open = Date.parse(session.open);
  return rows.map(([o, h, l, c, v = 1000], i) => {
    const start = open + (from + i) * FIVE;
    return {
      start: new Date(start).toISOString(),
      end: new Date(start + FIVE).toISOString(),
      open: new Decimal(o),
      high: new Decimal(h),
      low: new Decimal(l),
      close: new Decimal(c),
      volume: new Decimal(v),
    };
  });
}

const key5m = seriesKey({
  instrumentId: A,
  interval: '5m',
  adjustment: 'split_and_dividend',
  session: 'regular',
});
const data5m = (bars: Bar[]): LoadedData => ({
  series: new Map([[key5m, bars]]),
  dataVersions: ['test@1'],
  warnings: [],
});
const close5m = (): MarketExpr => ({
  kind: 'market',
  id: 'm-close',
  instrumentId: A,
  field: 'close',
  interval: '5m',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset: 0,
});

/** Buys 10 when the 5-minute close is above `level`; never exits. */
function buyAbove(level: string) {
  const def = createDefinition(sequentialIds('g'));
  delete def.risk.trailingStopPct;
  def.risk.priceCollarPct = '5';
  def.entry.condition.children = [compare(close5m(), 'gt', constant(level))];
  def.entry.trigger = { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 };
  def.entry.orders = [leg('buy')];
  def.exit.condition.children = [compare(close5m(), 'lt', constant('-1'))];
  def.exit.orders = [leg('sell', { side: 'close' })];
  return def;
}

const run = (bars: Bar[], from: string, to: string) =>
  simulate({
    definition: buyAbove('100'),
    instruments: INSTRUMENTS,
    inputs: inputs(from, to, { interval: '5m', slippageBps: '0' }),
    data: data5m(bars),
  });

describe('price collar anchor in back tests (N325)', () => {
  it('A3: within one session it still cancels a fill past the collar from the decision price', () => {
    // Decided at the 9:35 close of 101; the next bar opens at 110 (+8.9%), same session.
    const bars = fiveMinute('2025-03-03', [
      [99, 99, 99, 99],
      [101, 101, 101, 101],
      [110, 110, 110, 110],
      [110, 110, 110, 110],
    ]);
    const r = run(bars, '2025-03-03', '2025-03-03');
    expect(r.orders![0]).toMatchObject({
      phase: 'entry',
      outcome: 'canceled',
      reason: 'collar_cancel',
      detail: {
        reference: '101',
        referenceSource: 'decision',
        referenceAt: bars[1]!.end,
        price: '110',
        priceAt: bars[2]!.start,
        movePct: '8.91',
        limitPct: '5',
      },
    });
  });

  it('A1: an order decided on the last bar of a session fills at a gapped open the next session', () => {
    // Friday's last bar closes at 101 (crossing 100); Monday opens at 107.2 (+6.1%).
    const friday = fiveMinute(
      '2025-02-28',
      [
        [99, 99, 99, 99],
        [101, 101, 101, 101],
      ],
      76,
    );
    const monday = fiveMinute('2025-03-03', [[107.2, 107.5, 107, 107.2]]);
    const r = run([...friday, ...monday], '2025-02-28', '2025-03-03');
    expect(r.fills.map((f) => [f.time, f.side, f.price])).toEqual([
      [monday[0]!.start, 'buy', '107.2'],
    ]);
    expect(r.warnings.map((w) => w.code)).not.toContain('collar_cancel');
  });

  it('A2: a stop that works into a later session is collared on that session, not the decision', () => {
    const def = buyAbove('100');
    // A buy stop at 120, good till canceled: decided Friday at 101.
    def.entry.orders = [
      leg('buy', { orderType: 'stop', stopPrice: constant('120'), timeInForce: 'gtc' }),
    ];
    const friday = fiveMinute(
      '2025-02-28',
      [
        [99, 99, 99, 99],
        [101, 101, 101, 101],
      ],
      76,
    );
    // Monday's first price is 112 (the release snapshot); the stop then fills at 120,
    // +7.1% from 112 in the same session: past the 5% collar, so canceled.
    const monday = fiveMinute('2025-03-03', [
      [112, 113, 111, 112],
      [119, 121, 118, 120],
    ]);
    const r = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2025-02-28', '2025-03-03', { interval: '5m', slippageBps: '0' }),
      data: data5m([...friday, ...monday]),
    });
    expect(r.orders![0]).toMatchObject({
      outcome: 'canceled',
      reason: 'collar_cancel',
      detail: {
        reference: '112',
        referenceSource: 'release_snapshot',
        referenceAt: monday[0]!.start,
        price: '120',
        priceAt: monday[1]!.start,
        movePct: '7.14',
      },
    });
    // Never the Friday price.
    expect(r.orders![0]!.detail.reference).not.toBe('101');
  });
});
