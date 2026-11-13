import { describe, expect, it } from 'vitest';
import { stepTrigger, initialTriggerState } from '../execution/trigger';
import { createDefinition } from './defaults';
import { IMMEDIATE_TRIGGER, isImmediateTrigger, strategyDefinitionSchema } from './schema';
import { describeTrigger } from './text';

/** Builder defaults (N273): Fire when "Immediately" and round up. */
describe('builder defaults (N273)', () => {
  it('starts a new strategy with Fire when "Immediately" on Entry and Exit', () => {
    const def = createDefinition();
    expect(def.entry.trigger).toEqual(IMMEDIATE_TRIGGER);
    expect(def.exit.trigger).toEqual(IMMEDIATE_TRIGGER);
    expect(isImmediateTrigger(def.entry.trigger)).toBe(true);
    expect(describeTrigger(def.entry.trigger)).toBe('Immediately, on every check it is true');
  });

  it('fires on every check the condition is true, including the first', () => {
    const state = initialTriggerState();
    const fires = [true, true, false, true].map((t, i) =>
      stepTrigger(state, t, i, IMMEDIATE_TRIGGER),
    );
    expect(fires).toEqual([true, true, false, true]);
  });

  it('keeps saved Fire when and rounding as they were', () => {
    expect(
      isImmediateTrigger({ mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 }),
    ).toBe(false);
    expect(isImmediateTrigger({ mode: 'while_true', cooldownBars: 2, confirmationBars: 0 })).toBe(
      false,
    );
    const def = createDefinition();
    const parsed = strategyDefinitionSchema.parse({
      ...def,
      entry: {
        ...def.entry,
        trigger: undefined,
        orders: [
          {
            id: 'leg1',
            legLabel: 'Buy',
            instrumentId: '11111111-1111-4111-8111-111111111111',
            accountId: '33333333-3333-4333-8333-333333333333',
            side: 'buy',
            quantity: { type: 'units', value: '1' },
            orderType: 'market',
          },
        ],
      },
    });
    // A saved definition without these fields reads as it always did.
    expect(parsed.entry.trigger.mode).toBe('on_transition');
    expect(parsed.entry.orders[0]?.quantity.rounding).toBe('down');
  });
});
