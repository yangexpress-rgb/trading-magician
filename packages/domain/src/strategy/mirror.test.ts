import { describe, expect, it } from 'vitest';
import { createDefinition } from './defaults';
import { sequentialIds } from './ids';
import { exitFollowsEntry, mirrorEntryOrders, refillExitOrders, syncExitWithEntry } from './mirror';
import type { StrategyDefinition } from './schema';
import { order, OTHER_ACCOUNT, STOCK_A, STOCK_B } from './test-fixtures';

function withEntry(...legs: ReturnType<typeof order>[]): StrategyDefinition {
  const def = createDefinition(sequentialIds('g'));
  def.entry.orders = legs;
  return def;
}

/** What the editor does when one Entry leg changes. */
function editEntry(def: StrategyDefinition, i: number, patch: Partial<ReturnType<typeof order>>) {
  const orders = def.entry.orders.map((o, j) => (j === i ? { ...o, ...patch } : o));
  return syncExitWithEntry(def, { ...def, entry: { ...def.entry, orders } }, sequentialIds('x'));
}

describe('mirrorEntryOrders', () => {
  it('turns Buy into Sell and Sell short into Buy to cover, same instrument and quantity', () => {
    const exits = mirrorEntryOrders(
      [
        order('Entry leg 1', { side: 'buy', instrumentId: STOCK_A }),
        order('Short B', {
          side: 'sell_short',
          instrumentId: STOCK_B,
          quantity: { type: 'units', value: '25', rounding: 'down' },
        }),
      ],
      sequentialIds('x'),
    );
    expect(exits.map((o) => [o.id, o.legLabel, o.side, o.instrumentId, o.quantity.value])).toEqual([
      ['x1', 'Exit leg 1', 'sell', STOCK_A, '10'],
      ['x2', 'Exit Short B', 'buy_to_cover', STOCK_B, '25'],
    ]);
  });

  it('exits at market for the day, immediately, on the same account', () => {
    const [exit] = mirrorEntryOrders([
      order('e1', {
        orderType: 'limit',
        timeInForce: 'gtc',
        accountId: OTHER_ACCOUNT,
        extendedHours: true,
        timing: { mode: 'exact', at: '2026-11-03T15:00:00Z', zone: 'America/New_York' },
        timingOnly: true,
        notes: 'entry note',
      }),
    ]);
    expect(exit).toMatchObject({
      orderType: 'market',
      timeInForce: 'day',
      accountId: OTHER_ACCOUNT,
      extendedHours: true,
      timing: { mode: 'immediate' },
      timingOnly: false,
    });
    expect(exit).not.toHaveProperty('limitPrice');
    expect(exit).not.toHaveProperty('notes');
  });

  it('closes the instrument when Entry is sized in cash, % of equity or by risk, once each', () => {
    const notional = { type: 'notional' as const, value: '5000', rounding: 'down' as const };
    const exits = mirrorEntryOrders([
      order('a1', { quantity: notional }),
      order('a2', { quantity: notional }),
      order('b1', { instrumentId: STOCK_B, quantity: { ...notional, type: 'pct_equity' } }),
    ]);
    expect(exits.map((o) => [o.side, o.instrumentId])).toEqual([
      ['close', STOCK_A],
      ['close', STOCK_B],
    ]);
  });

  it('keeps leg names unique across Entry and Exit', () => {
    const exits = mirrorEntryOrders([order('Exit A'), order('A')]);
    expect(exits.map((o) => o.legLabel)).toEqual(['Exit Exit A', 'Exit A 2']);
  });
});

describe('Exit follows Entry until the user edits it', () => {
  it('fills Exit when the first Entry leg is added', () => {
    const empty = createDefinition(sequentialIds('g'));
    const after = syncExitWithEntry(
      empty,
      { ...empty, entry: { ...empty.entry, orders: [order('Entry leg 1')] } },
      sequentialIds('x'),
    );
    expect(after.exit.orders).toHaveLength(1);
    expect(after.exit.orders[0]).toMatchObject({ id: 'x1', side: 'sell', legLabel: 'Exit leg 1' });
    expect(exitFollowsEntry(after)).toBe(true);
  });

  it('tracks Entry changes and keeps the Exit leg id', () => {
    const def = refillExitOrders(withEntry(order('e1')), sequentialIds('x'));
    const next = editEntry(def, 0, {
      instrumentId: STOCK_B,
      side: 'sell_short',
      quantity: { type: 'units', value: '40', rounding: 'down' },
    });
    expect(next.exit.orders[0]).toMatchObject({
      id: 'x1',
      instrumentId: STOCK_B,
      side: 'buy_to_cover',
      quantity: { value: '40' },
    });
  });

  it('stops following once an Exit leg is changed', () => {
    const def = refillExitOrders(withEntry(order('e1')), sequentialIds('x'));
    def.exit.orders[0] = { ...def.exit.orders[0]!, orderType: 'limit' };
    expect(exitFollowsEntry(def)).toBe(false);
    const next = editEntry(def, 0, { quantity: { type: 'units', value: '99', rounding: 'down' } });
    expect(next.exit.orders).toEqual(def.exit.orders);
  });

  it('stops following once an Exit leg is added', () => {
    const def = refillExitOrders(withEntry(order('e1')), sequentialIds('x'));
    def.exit.orders.push(order('extra', { side: 'close' }));
    expect(exitFollowsEntry(def)).toBe(false);
  });

  it('adds and drops Exit legs with Entry legs, keeping a sequential leg order in step', () => {
    let def = refillExitOrders(withEntry(order('e1'), order('e2')), sequentialIds('x'));
    def.execution = {
      ...def.execution,
      multiLegPolicy: 'sequential',
      legOrder: ['e1', 'e2', 'x1', 'x2'],
    };
    def = syncExitWithEntry(def, {
      ...def,
      entry: { ...def.entry, orders: [def.entry.orders[0]!] },
      execution: { ...def.execution, legOrder: ['e1', 'x1', 'x2'] },
    });
    expect(def.exit.orders.map((o) => o.id)).toEqual(['x1']);
    expect(def.execution.legOrder).toEqual(['e1', 'x1']);

    def = syncExitWithEntry(
      def,
      {
        ...def,
        entry: { ...def.entry, orders: [...def.entry.orders, order('e3')] },
        execution: { ...def.execution, legOrder: ['e1', 'x1', 'e3'] },
      },
      sequentialIds('y'),
    );
    expect(def.exit.orders.map((o) => o.id)).toEqual(['x1', 'y1']);
    expect(def.execution.legOrder).toEqual(['e1', 'x1', 'e3', 'y1']);
  });

  it('leaves the definition alone when Entry orders did not change', () => {
    const def = withEntry(order('e1'));
    const after = { ...def, risk: { ...def.risk, maxActiveOrders: 3 } };
    expect(syncExitWithEntry(def, after)).toBe(after);
  });
});
