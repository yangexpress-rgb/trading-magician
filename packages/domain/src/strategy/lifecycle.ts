import type { ValidationResult } from './validate';

/**
 * Strategy business status (Design v1.0 §6.3). Runtime health is a separate
 * concept and is never derived from this status.
 */
export const STRATEGY_STATUSES = ['created', 'under_testing', 'actively_executing', 'off'] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

export const STATUS_LABELS: Record<StrategyStatus, string> = {
  created: 'Created',
  under_testing: 'Under testing',
  actively_executing: 'Actively executing',
  off: 'Off',
};

export const RUNTIME_HEALTH = [
  'not_running',
  'starting',
  'monitoring',
  'waiting_for_entry',
  'entry_pending',
  'position_open',
  'waiting_for_exit',
  'exit_pending',
  'paused',
  'error',
  'stopped',
] as const;
export type RuntimeHealth = (typeof RUNTIME_HEALTH)[number];

const TRANSITIONS: Record<StrategyStatus, readonly StrategyStatus[]> = {
  created: ['under_testing'],
  under_testing: ['created', 'actively_executing'],
  actively_executing: ['off'],
  off: ['under_testing', 'actively_executing'],
};

export function allowedTransitions(from: StrategyStatus): readonly StrategyStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: StrategyStatus, to: StrategyStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface TransitionRequest {
  from: StrategyStatus;
  to: StrategyStatus;
  /** Required when activating. */
  validation?: ValidationResult;
  /** Warning codes the user explicitly acknowledged. */
  acknowledgedWarnings?: readonly string[];
  /** The user confirmed the activation dialog. */
  confirmed?: boolean;
}

export type TransitionPlan =
  | { ok: true; to: StrategyStatus; snapshotVersion: boolean }
  | {
      ok: false;
      reason: 'not_allowed' | 'validation_errors' | 'unacknowledged_warnings' | 'not_confirmed';
      message: string;
      details?: readonly string[];
    };

/**
 * Decides whether a status change may happen. Activation requires a clean
 * validation, every warning acknowledged, and an explicit confirmation, and it
 * always pins an immutable version (§6.2, §6.10, §5.2).
 */
export function planTransition(req: TransitionRequest): TransitionPlan {
  if (!canTransition(req.from, req.to)) {
    return {
      ok: false,
      reason: 'not_allowed',
      message: `A strategy can't go from ${STATUS_LABELS[req.from]} to ${STATUS_LABELS[req.to]}`,
    };
  }
  if (req.to !== 'actively_executing') return { ok: true, to: req.to, snapshotVersion: false };

  const v = req.validation;
  if (!v) throw new Error('Activation requires a validation result');
  if (v.errors.length > 0) {
    return {
      ok: false,
      reason: 'validation_errors',
      message: 'Fix the problems listed before starting this strategy',
      details: v.errors.map((e) => e.message),
    };
  }
  const acknowledged = new Set(req.acknowledgedWarnings ?? []);
  const pending = v.warnings.filter((w) => !acknowledged.has(w.code));
  if (pending.length > 0) {
    return {
      ok: false,
      reason: 'unacknowledged_warnings',
      message: 'Review and acknowledge the warnings before starting',
      details: [...new Set(pending.map((w) => w.code))],
    };
  }
  if (!req.confirmed) {
    return { ok: false, reason: 'not_confirmed', message: 'Confirm to start this strategy' };
  }
  return { ok: true, to: 'actively_executing', snapshotVersion: true };
}

/**
 * Once a strategy has run, edits are saved as a new immutable version so
 * history keeps pointing at the exact rules that produced each order (§6.2).
 */
export function editsCreateNewVersion(hasBeenActive: boolean): boolean {
  return hasBeenActive;
}
