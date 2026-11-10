import {
  CONTEXT_INSTRUMENT_ID,
  createDefinition,
  refillExitOrders,
  slotModeOf,
  strategyDefinitionSchema,
  type StrategyDefinition,
} from '@tm/domain';
import { describe, expect, it } from 'vitest';
import {
  addAsset,
  fromLegsSelection,
  removeAsset,
  replaceAsset,
  withExitShortcut,
  withLeftGroup,
  toAssets,
  toGroup,
  tradedAssets,
} from './slot-edits';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';

function fixed(): StrategyDefinition {
  const def = createDefinition();
  def.entry.orders = [
    {
      id: 'leg1',
      legLabel: 'Buy A',
      instrumentId: A,
      accountId: ACCOUNT,
      side: 'buy',
      quantity: { type: 'units', value: '10', rounding: 'down' },
      orderType: 'market',
      timeInForce: 'day',
      timing: { mode: 'immediate' },
    },
  ];
  return def;
}

describe('What to trade: a group (ADR 0073)', () => {
  it('makes one leg that buys each pick, per pick, closed by Exit, with "Left the group"', () => {
    const def = toGroup(fixed(), [A, B]);
    expect(slotModeOf(def)).toBe('selection');
    expect(def.entry.orders).toHaveLength(1);
    expect(def.entry.orders[0]).toMatchObject({
      legLabel: 'Buy each pick',
      instrumentId: CONTEXT_INSTRUMENT_ID,
      quantity: { type: 'notional', value: '3000' },
    });
    expect(def.exit.orders).toHaveLength(1);
    expect(def.exit.orders[0]).toMatchObject({
      instrumentId: CONTEXT_INSTRUMENT_ID,
      side: 'close',
    });
    expect(def.trade).toMatchObject({
      kind: 'group',
      universe: { type: 'list', instrumentIds: [A, B] },
      ranking: { metric: 'return', direction: 'desc', count: { type: 'fixed', value: 2 } },
    });
    expect(def.exit.rules?.map((r) => r.kind)).toEqual(['leftGroup']);
    expect(def.execution.reentry).toEqual({ mode: 'single_cycle' });
    expect(def.execution.multiLegPolicy).toBe('concurrent');
    // Month-end Entry checks, daily Exit checks (O145).
    expect(def.entry.schedule).toEqual({ frequency: 'monthEnd' });
    expect(def.exit.schedule).toEqual({ frequency: 'daily' });
    expect(strategyDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it('defaults to the S&P 500 when no instruments are known and keeps a chosen schedule', () => {
    const start = fixed();
    start.entry.schedule = { frequency: 'bar5m' };
    const def = toGroup(start, []);
    expect(def.trade).toMatchObject({ universe: { type: 'builtin', id: 'sp500' } });
    expect(def.entry.schedule).toEqual({ frequency: 'bar5m' });
    expect(def.exit.schedule).toEqual({ frequency: 'bar5m' });
  });

  it('goes back to specific assets on a named instrument', () => {
    const def = toAssets(toGroup(fixed(), [A, B]), B);
    expect(slotModeOf(def)).toBe('none');
    expect(def.trade).toEqual({ kind: 'assets' });
    expect(def.exit.rules).toBeUndefined();
    expect(def.entry.orders[0]?.instrumentId).toBe(B);
    expect(def.exit.orders[0]?.instrumentId).toBe(B);
    expect(strategyDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it('turns "Sell a pick when it leaves the group" on and off (N222)', () => {
    const on = withLeftGroup(fixed(), true);
    expect(on.exit.rules?.map((r) => r.kind)).toEqual(['leftGroup']);
    expect(withLeftGroup(on, true).exit.rules).toHaveLength(1);
    expect(withLeftGroup(on, false).exit.rules).toBeUndefined();
  });

  it('adds the holding-period, ATR and expected-move exits to Exit when (N221)', () => {
    let def = fixed();
    for (const kind of ['holdingPeriod', 'atrStop', 'expectedMove'] as const)
      def = withExitShortcut(def, kind);
    expect(def.exit.rules).toBeUndefined();
    const text = JSON.stringify(def.exit.condition);
    for (const field of ['days_held', 'atrs_below_entry', 'expected_moves_5d'])
      expect(text).toContain(field);
    expect(def.exit.condition.op).toBe('or');
    expect(strategyDefinitionSchema.safeParse(def).success).toBe(true);
  });
});

describe('What to trade: specific assets (ADR 0073)', () => {
  it("lists the legs' assets, and swaps one everywhere it is named", () => {
    const def = fixed();
    def.entry.condition.children = [
      {
        kind: 'comparison',
        id: 'c',
        operator: 'gt',
        left: {
          kind: 'market',
          id: 'px',
          instrumentId: A,
          field: 'close',
          interval: '1d',
          adjustment: 'split_and_dividend',
          session: 'regular',
          offset: 0,
        },
        right: { kind: 'constant', id: 'k', value: '1' },
      },
    ];
    expect(tradedAssets(def)).toEqual([A]);
    const swapped = replaceAsset(def, A, B);
    expect(tradedAssets(swapped)).toEqual([B]);
    expect(JSON.stringify(swapped)).not.toContain(A);
  });

  it('adds and removes an asset, with its mirrored Exit leg', () => {
    const def = refillExitOrders(fixed());
    const two = addAsset(def, B);
    expect(tradedAssets(two)).toEqual([A, B]);
    expect(two.exit.orders.map((o) => o.instrumentId)).toEqual([A, B]);
    const one = removeAsset(two, A);
    expect(tradedAssets(one)).toEqual([B]);
    expect(one.exit.orders.map((o) => o.instrumentId)).toEqual([B]);
  });

  it('stops ranking legs kept from schema 2, keeping each leg', () => {
    const start = fixed();
    start.entry.rankedLegs = {
      metric: 'return',
      params: {},
      direction: 'desc',
      count: { type: 'fixed', value: 1 },
    };
    delete start.exit.trigger;
    expect(slotModeOf(start)).toBe('legs');
    const back = fromLegsSelection(start);
    expect(slotModeOf(back)).toBe('none');
    expect(back.exit.trigger).toBeDefined();
  });
});
