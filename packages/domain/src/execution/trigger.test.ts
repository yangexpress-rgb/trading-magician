import { describe, expect, it } from 'vitest';
import type { Truth } from '../strategy/evaluate';
import type { Trigger } from '../strategy/schema';
import {
  exitFiresDirectly,
  initialTriggerState,
  rearmEntryTrigger,
  stepTrigger,
  type TriggerState,
} from './trigger';

const run = (trigger: Trigger, truths: Truth[], state: TriggerState = initialTriggerState(false)) =>
  truths.map((t, i) => stepTrigger(state, t, i * 86_400_000, trigger));

describe('stepTrigger (ADR 0049)', () => {
  it('fires on the crossing bar itself with no confirmation', () => {
    const t: Trigger = { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 };
    expect(run(t, [false, true, true, false, true])).toEqual([false, true, false, false, true]);
  });

  it('counts the cooldown in bars: 2 bars block exactly one evaluation', () => {
    const t: Trigger = { mode: 'while_true', cooldownBars: 2, confirmationBars: 0 };
    expect(run(t, [true, true, true, true, true])).toEqual([true, false, true, false, true]);
    const none: Trigger = { ...t, cooldownBars: 1 };
    expect(run(none, [true, true, true])).toEqual([true, true, true]);
  });

  it('fires "once per cycle" again after its cycle closes and the trigger is re-armed', () => {
    const t: Trigger = { mode: 'once_per_cycle', cooldownBars: 0, confirmationBars: 0 };
    const state = initialTriggerState(false);
    expect(run(t, [true, true], state)).toEqual([true, false]);
    // The first cycle closes: the next true bar opens the second one.
    rearmEntryTrigger(state);
    expect(run(t, [true, true], state)).toEqual([true, false]);
    expect(state.fired).toBe(1);
  });

  it('keeps the run of true values and the cooldown across a re-arm', () => {
    const t: Trigger = { mode: 'once_per_cycle', cooldownBars: 3, confirmationBars: 0 };
    const state = initialTriggerState(false);
    expect(run(t, [true], state)).toEqual([true]);
    rearmEntryTrigger(state);
    expect(run(t, [true, true, true], state)).toEqual([false, false, true]);
  });
});

describe('slot-mode Exit', () => {
  it('exits on the first bar the condition is true, including straight after unknown', () => {
    expect([undefined, true, true, false].map(exitFiresDirectly)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
});
