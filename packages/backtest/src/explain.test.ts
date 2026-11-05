import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import {
  A,
  INSTRUMENTS,
  close,
  closes,
  compare,
  constant,
  inputs,
  leg,
  loaded,
  strategy,
} from './test-utils';

const FROM = '2024-03-04';

const crossover = () =>
  strategy(
    compare(close(), 'gt', constant('100')),
    [leg('buy-a')],
    compare(close(), 'lt', constant('100')),
    [leg('sell-a', { side: 'sell' })],
  );

const run = (values: number[], def = crossover()) =>
  simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs('2024-03-04', '2024-03-08'),
    data: loaded({ [A]: closes(FROM, values) }),
  });

describe('condition report', () => {
  it('logs the compared values and truth of each condition on each bar', () => {
    const def = crossover();
    const r = run([99, 101, 102, 98, 99], def);
    const entry = r.conditions!.entry;
    const cmpId = def.entry.condition.children[0]!.id;

    expect(entry).toMatchObject({ evaluated: 5, trueBars: 2, falseBars: 3, fired: 1 });
    expect(entry.bars.map((b) => [b.truth, b.outcome])).toEqual([
      [false, undefined],
      [true, 'fired'],
      [true, 'already_true'],
      [false, undefined],
      [false, undefined],
    ]);
    expect(entry.bars[1]!.checks).toContainEqual({
      id: cmpId,
      truth: true,
      left: '101',
      right: '100',
    });
    expect(entry.comparisons[0]).toMatchObject({ id: cmpId, trueBars: 2, falseBars: 3 });

    // Exit is only checked while the cycle holds a position, and names the cycle.
    const exit = r.conditions!.exit;
    expect(exit.bars.map((b) => [b.cycle, b.truth, b.outcome])).toEqual([
      [1, false, undefined],
      [1, true, 'fired'],
    ]);
  });

  it('says when Entry fired but a cycle was already open', () => {
    const def = crossover();
    def.entry.trigger.mode = 'while_true';
    const r = run([101, 102, 103, 104, 105], def);
    expect(r.conditions!.entry.bars.map((b) => b.outcome)).toEqual([
      'fired',
      'cycle_open',
      'cycle_open',
      'cycle_open',
      'cycle_open',
    ]);
  });
});

describe('order report', () => {
  it('reports an Exit decided on the last bar as working at the end, with no bar to fill on', () => {
    const r = run([99, 101, 102, 98]);
    expect(r.orders!.map((o) => [o.phase, o.outcome, o.reason])).toEqual([
      ['entry', 'filled', null],
      ['exit', 'working_at_end', 'no_bar_after'],
    ]);
    expect(r.orders![0]).toMatchObject({ quantity: '10', filledQuantity: '10', fills: 1 });
  });

  it('reports an Exit whose conditions never held as not sent', () => {
    const r = run([99, 101, 102, 103, 104]);
    expect(r.orders!.at(-1)).toMatchObject({
      phase: 'exit',
      outcome: 'not_sent',
      reason: 'exit_not_triggered',
      decidedAt: null,
    });
  });

  it('gives the figures behind a price-collar cancel', () => {
    const r = run([99, 101, 110, 110, 110]);
    expect(r.orders![0]).toMatchObject({
      phase: 'entry',
      outcome: 'canceled',
      reason: 'collar_cancel',
      referencePrice: '101',
      detail: { reference: '101', price: '110', movePct: '8.91', limitPct: '5' },
    });
  });

  it('gives the limit and value behind a risk rejection', () => {
    const def = crossover();
    def.entry.orders = [
      leg('buy-a', { quantity: { type: 'units', value: '200', rounding: 'down' } }),
    ];
    const r = run([99, 101, 101, 101, 101], def);
    expect(r.orders![0]).toMatchObject({
      outcome: 'rejected',
      reason: 'risk_order_size',
      detail: { limit: def.risk.maxOrderNotional, value: '20200.00' },
    });
  });
});
