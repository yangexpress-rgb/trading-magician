import type Decimal from 'decimal.js';
import { stopCloseExpr, stopInterval } from './risk-exits';
import type { EntryPhase, ExitPhase, ExitRule, PositionExpr, StrategyDefinition } from './schema';
import { walkExpressions } from './tree';

/**
 * The trailing stop (ADR 0059). From the entry price, the cycle keeps the
 * best daily close since Entry filled: the highest for a long, the lowest for
 * a short. A daily close more than `percent` % below that peak (above it, for
 * a short) exits every leg, by OR with the Exit condition. The first Entry
 * leg's instrument is watched, as with the ATR stop. Back tests and paper runs
 * both call these.
 */

export type TrailingStopRule = Extract<ExitRule, { kind: 'trailingStop' }>;

type Part = { entry: Pick<EntryPhase, 'orders'>; exit: Pick<ExitPhase, 'rules'> };

export function trailingStopRuleOf(part: Pick<Part, 'exit'>): TrailingStopRule | undefined {
  return part.exit.rules?.find((r): r is TrailingStopRule => r.kind === 'trailingStop');
}

/** The closes (at the Check Exit bar size, O144) every part's trailing stop is checked against, on the run's price basis. */
export function trailingStopCloses(
  def: StrategyDefinition,
  adjustment: Parameters<typeof stopCloseExpr>[1] = 'split_and_dividend',
) {
  const out: ReturnType<typeof stopCloseExpr>[] = [];
  for (const p of [def, ...(def.groups ?? [])]) {
    const instrument = p.entry.orders[0]?.instrumentId;
    if (trailingStopRuleOf(p) && instrument)
      out.push(stopCloseExpr(instrument, adjustment, stopInterval(def)));
  }
  return out;
}

/** The "off best close since entry" values a definition's Exit when reads (N217). */
function offPeakExprs(def: StrategyDefinition): PositionExpr[] {
  const out: PositionExpr[] = [];
  for (const p of [def, ...(def.groups ?? [])])
    for (const e of walkExpressions(p.exit.condition))
      if (e.kind === 'position' && e.field === 'off_peak_pct') out.push(e);
  return out;
}

/** Whether Exit when reads "off best close since entry", so the engines keep each holding's peak. */
export function readsOffPeak(def: StrategyDefinition): boolean {
  return offPeakExprs(def).length > 0;
}

/** The closes that peak is kept from: at the Check Exit bar size, on the run's price basis. */
export function offPeakCloses(
  def: StrategyDefinition,
  adjustment: Parameters<typeof stopCloseExpr>[1] = 'split_and_dividend',
) {
  const ids = new Set(offPeakExprs(def).map((e) => e.instrumentId));
  return [...ids].map((id) => stopCloseExpr(id, adjustment, stopInterval(def)));
}

/** The peak after a close: the best of the previous peak and the close. */
export function trailingPeak(peak: Decimal, close: Decimal, long: boolean): Decimal {
  return long ? (close.gt(peak) ? close : peak) : close.lt(peak) ? close : peak;
}

/** The stop level for a peak: peak × (1 − percent/100) for a long, × (1 + percent/100) for a short. */
export function trailingStopLevel(peak: Decimal, percent: string, long: boolean): Decimal {
  const f = peak.times(percent).div(100);
  return long ? peak.minus(f) : peak.plus(f);
}

/** Whether a close is past the level: below it for a long, above it for a short. */
export const trailingStopHit = (close: Decimal, level: Decimal, long: boolean) =>
  long ? close.lt(level) : close.gt(level);
