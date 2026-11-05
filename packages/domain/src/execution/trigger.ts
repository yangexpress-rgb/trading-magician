import type { Truth } from '../strategy/evaluate';
import type { Phase } from '../strategy/schema';

/**
 * Trigger qualification (Design v1.0 §6.5 step 6), shared by the back test and
 * the paper runtime. A trigger advances once per evaluation on new data; the
 * state is plain JSON so the runtime can store it between evaluations.
 */
export interface TriggerState {
  prev: Truth;
  consecutive: number;
  /** Epoch milliseconds of the last time the trigger fired. */
  lastFired?: number | undefined;
  fired: number;
}

export const initialTriggerState = (prev: Truth = undefined): TriggerState => ({
  prev,
  consecutive: 0,
  fired: 0,
});

/** Advances a trigger by one evaluation and says whether it fires. Mutates `state`. */
export function stepTrigger(
  state: TriggerState,
  truth: Truth,
  now: number,
  trigger: Phase['trigger'],
): boolean {
  const prev = state.prev;
  state.prev = truth;
  state.consecutive = truth === true ? state.consecutive + 1 : 0;
  if (truth !== true || state.consecutive < trigger.confirmationBars + 1) return false;
  if (state.lastFired !== undefined && now - state.lastFired < trigger.cooldownSec * 1000) {
    return false;
  }
  if (trigger.mode === 'on_transition') {
    // Fires once per run of true values: on the evaluation that completes the confirmation.
    const justConfirmed = state.consecutive === trigger.confirmationBars + 1;
    if (!justConfirmed || (trigger.confirmationBars === 0 && prev !== false)) return false;
  }
  if (trigger.mode === 'once_per_cycle' && state.fired > 0) return false;
  state.lastFired = now;
  state.fired += 1;
  return true;
}
