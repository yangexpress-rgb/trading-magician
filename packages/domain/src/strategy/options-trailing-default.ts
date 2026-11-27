import { DEFAULT_RISK } from './defaults';
import type { StrategyDefinition } from './schema';
import { hasOptionLegs } from './validate-options';

/**
 * O231 (Yong's decision, 2026-11-27; brief §8.4): options strategies start with
 * the strategy trailing stop off. New strategies get the 1% default before they
 * have any legs, so the default flips when a strategy gains its first options
 * leg: if its trailing stop is still the untouched creation default, it becomes
 * off. A value the user set deliberately (`risk.trailingStopSet`) is never
 * overridden, and the low-value warning for options strategies stays.
 *
 * `before` is the saved definition (undefined for a new strategy). Returns
 * `next` unchanged unless the flip applies.
 */
export function optionsTrailingStopDefault(
  before: StrategyDefinition | undefined,
  next: StrategyDefinition,
): StrategyDefinition {
  if (!hasOptionLegs(next)) return next;
  if (before && hasOptionLegs(before)) return next;
  const risk = next.risk;
  if (risk.trailingStopSet === true) return next;
  if (risk.trailingStopPct !== DEFAULT_RISK.trailingStopPct) return next;
  const rest = { ...risk };
  delete rest.trailingStopPct;
  return { ...next, risk: rest };
}
