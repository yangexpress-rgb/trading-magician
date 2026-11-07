import type { Truth } from '../strategy/evaluate';
import type { Trigger } from '../strategy/schema';

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
  /** Firings since the trigger was last re-armed (a cycle closed, for Entry). */
  fired: number;
  /** Evaluations so far, and the one it last fired on: the cooldown counts bars (ADR 0049). */
  evaluations?: number | undefined;
  lastFiredEvaluation?: number | undefined;
}

export const initialTriggerState = (prev: Truth = undefined): TriggerState => ({
  prev,
  consecutive: 0,
  fired: 0,
});

/**
 * Whether the cooldown still blocks: a cooldown of N bars lets the trigger
 * fire again N evaluations after it last fired, so 2 bars block exactly the
 * one evaluation in between. 0 and 1 never block.
 */
export function inCooldown(state: TriggerState, trigger: Trigger): boolean {
  if (state.lastFiredEvaluation === undefined) return false;
  return (state.evaluations ?? 0) - state.lastFiredEvaluation < trigger.cooldownBars;
}

/** Advances a trigger by one evaluation and says whether it fires. Mutates `state`. */
export function stepTrigger(
  state: TriggerState,
  truth: Truth,
  now: number,
  trigger: Trigger,
): boolean {
  const prev = state.prev;
  state.prev = truth;
  state.evaluations = (state.evaluations ?? 0) + 1;
  state.consecutive = truth === true ? state.consecutive + 1 : 0;
  if (truth !== true || state.consecutive < trigger.confirmationBars + 1) return false;
  if (inCooldown(state, trigger)) return false;
  if (trigger.mode === 'on_transition') {
    // Fires once per run of true values: on the evaluation that completes the confirmation.
    const justConfirmed = state.consecutive === trigger.confirmationBars + 1;
    if (!justConfirmed || (trigger.confirmationBars === 0 && prev !== false)) return false;
  }
  if (trigger.mode === 'once_per_cycle' && state.fired > 0) return false;
  state.lastFired = now;
  state.lastFiredEvaluation = state.evaluations;
  state.fired += 1;
  return true;
}

/**
 * Re-arms an Entry trigger when one of its cycles closes or is aborted
 * (ADR 0049), so "once per cycle" fires once per cycle, not once per run.
 * Only the firing count is reset: the run of true values and the cooldown
 * carry on. Mutates `state`.
 */
export function rearmEntryTrigger(state: TriggerState): void {
  state.fired = 0;
}

/**
 * Slot mode (a Selection group or per-leg conditions) has no Exit trigger
 * (ADR 0049): the Exit condition exits on every bar it is true.
 */
export const exitFiresDirectly = (truth: Truth): boolean => truth === true;
