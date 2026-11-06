import {
  CONTEXT_INSTRUMENT_ID,
  createDefinition,
  slotModeOf,
  strategyDefinitionSchema,
  type StrategyDefinition,
} from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { timeStopRule, toFixedLegs, toSelectionGroup } from './slot-edits';

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
      extendedHours: false,
      timing: { mode: 'immediate' },
      timingOnly: false,
    },
  ];
  return def;
}

describe('switching Entry to a Selection group', () => {
  it('makes one template leg that trades each selected instrument, closed by Exit', () => {
    const def = toSelectionGroup(fixed(), [A, B]);
    expect(slotModeOf(def)).toBe('selection');
    expect(def.entry.orders).toHaveLength(1);
    expect(def.entry.orders[0]).toMatchObject({
      instrumentId: CONTEXT_INSTRUMENT_ID,
      quantity: { type: 'notional', value: '9000' },
    });
    expect(def.exit.orders).toHaveLength(1);
    expect(def.exit.orders[0]).toMatchObject({
      instrumentId: CONTEXT_INSTRUMENT_ID,
      side: 'close',
    });
    expect(def.entry.selection?.universe).toEqual({ type: 'list', instrumentIds: [A, B] });
    expect(def.execution.reentry).toEqual({ mode: 'single_cycle' });
    expect(def.execution.multiLegPolicy).toBe('concurrent');
    expect(def.schedule).toEqual({ frequency: 'monthEnd' });
    expect(strategyDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it('defaults to the S&P 500 when no instruments are known and keeps a chosen schedule', () => {
    const start = { ...fixed(), schedule: { frequency: 'weekly' as const } };
    const def = toSelectionGroup(start, []);
    expect(def.entry.selection?.universe).toEqual({ type: 'builtin', id: 'sp500' });
    expect(def.schedule).toEqual({ frequency: 'weekly' });
  });

  it('goes back to fixed legs on a named instrument', () => {
    const def = toFixedLegs(toSelectionGroup(fixed(), [A, B]), B);
    expect(slotModeOf(def)).toBe('none');
    expect(def.entry.selection).toBeUndefined();
    expect(def.entry.orders[0]?.instrumentId).toBe(B);
    expect(def.exit.orders[0]?.instrumentId).toBe(B);
    expect(strategyDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it('adds a time stop that parses', () => {
    const def = fixed();
    def.exit.rules = [timeStopRule(5)];
    expect(strategyDefinitionSchema.safeParse(def).success).toBe(true);
  });
});
