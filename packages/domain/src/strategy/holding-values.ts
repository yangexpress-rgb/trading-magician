import { expectedMoveExpr } from './expected-move-exit';
import { atrExpr, stopCloseExpr, stopInterval } from './risk-exits';
import type { PositionExpr, PositionField, StrategyDefinition } from './schema';
import { walkExpressions } from './tree';
import { DEFAULT_HOLDING_ATR_PERIOD } from './evaluate';

/**
 * Position values that read what the engines keep for each holding (N217,
 * N221, ADR 0074, ADR 0076): the best close since entry, the close at the
 * Check Exit bar size, trading days held, and the ATR and expected move as
 * they were when Entry was decided. The engines keep them only for a
 * strategy whose Exit when reads one.
 */

const HOLDING_FIELDS: ReadonlySet<PositionField> = new Set([
  'off_peak_pct',
  'days_held',
  'atrs_below_entry',
  'expected_moves_1d',
  'expected_moves_5d',
  'minutes_held',
]);

/** Every such value the Exit when of a definition, or of its entry groups, reads. */
export function holdingExprs(def: StrategyDefinition): PositionExpr[] {
  const out: PositionExpr[] = [];
  for (const p of [def, ...(def.groups ?? [])])
    for (const e of walkExpressions(p.exit.condition))
      if (e.kind === 'position' && HOLDING_FIELDS.has(e.field)) out.push(e);
  return out;
}

export interface HoldingReads {
  /** Whether Exit when reads any of them, so the engines keep closes, peaks and days held. */
  any: boolean;
  /** The ATR periods to fix at entry. */
  atrPeriods: number[];
  /** The expected-move horizons to fix at entry. */
  moveHorizons: (1 | 5)[];
}

export function holdingReads(def: StrategyDefinition): HoldingReads {
  const exprs = holdingExprs(def);
  const atr = new Set<number>();
  const moves = new Set<1 | 5>();
  for (const e of exprs) {
    if (e.field === 'atrs_below_entry') atr.add(e.period ?? DEFAULT_HOLDING_ATR_PERIOD);
    if (e.field === 'expected_moves_1d') moves.add(1);
    if (e.field === 'expected_moves_5d') moves.add(5);
  }
  return { any: exprs.length > 0, atrPeriods: [...atr], moveHorizons: [...moves] };
}

/** The options metrics these values fix at entry, for loading signals and checking the feed. */
export function holdingMoveExprs(def: StrategyDefinition) {
  return holdingExprs(def).flatMap((e) =>
    e.field === 'expected_moves_1d'
      ? [expectedMoveExpr(e.instrumentId, 1)]
      : e.field === 'expected_moves_5d'
        ? [expectedMoveExpr(e.instrumentId, 5)]
        : [],
  );
}

/** The series the engines read for them: closes at the Check Exit bar size and the ATRs at entry. */
export function holdingSeries(
  def: StrategyDefinition,
  adjustment: Parameters<typeof stopCloseExpr>[1] = 'split_and_dividend',
) {
  const out: (ReturnType<typeof stopCloseExpr> | ReturnType<typeof atrExpr>)[] = [];
  const seen = new Set<string>();
  for (const e of holdingExprs(def)) {
    // Minutes held reads the clock, not closes (N254).
    if (e.field === 'minutes_held') continue;
    const close = stopCloseExpr(e.instrumentId, adjustment, stopInterval(def));
    if (!seen.has(close.id)) out.push(close);
    seen.add(close.id);
    if (e.field === 'atrs_below_entry') {
      const atr = atrExpr(e.instrumentId, e.period ?? DEFAULT_HOLDING_ATR_PERIOD, adjustment);
      if (!seen.has(atr.id)) out.push(atr);
      seen.add(atr.id);
    }
  }
  return out;
}
