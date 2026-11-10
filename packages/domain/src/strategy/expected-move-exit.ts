import type Decimal from 'decimal.js';
import { optionMetricId } from './metrics';
import { stopCloseExpr, stopInterval } from './risk-exits';
import type { EntryPhase, ExitPhase, ExitRule, MetricExpr, StrategyDefinition } from './schema';

/**
 * The expected-move exit (options brief v2 §10 item 10, ADR 0053). When Entry
 * is decided, the first Entry leg's expected move (the recorded options
 * signal, as a fraction of the price) is captured and kept with the cycle, as
 * the ATR stop keeps its ATR. A daily close that has moved from the average
 * entry price by more than `multiple` × that move exits, by OR with the Exit
 * condition. Back tests and paper runs both call these.
 */

export type ExpectedMoveRule = Extract<ExitRule, { kind: 'expectedMove' }>;

type Part = { entry: Pick<EntryPhase, 'orders'>; exit: Pick<ExitPhase, 'rules'> };

export function expectedMoveRuleOf(part: Pick<Part, 'exit'>): ExpectedMoveRule | undefined {
  return part.exit.rules?.find((r): r is ExpectedMoveRule => r.kind === 'expectedMove');
}

/** The options metric the rule captures at entry: expected move over 1 or 5 days, as a fraction. */
export function expectedMoveExpr(instrumentId: string, horizon: 1 | 5): MetricExpr {
  return {
    kind: 'metric',
    id: `expected-move-${horizon}-${instrumentId}`,
    metric: optionMetricId(horizon === 1 ? 'expected_move_1d_pct' : 'expected_move_5d_pct'),
    params: {},
    instrumentId,
  };
}

/** The expected-move metrics every part of a definition captures, for loading signals. */
export function expectedMoveExprs(def: StrategyDefinition): MetricExpr[] {
  const out: MetricExpr[] = [];
  for (const p of [def, ...(def.groups ?? [])]) {
    const rule = expectedMoveRuleOf(p);
    const instrument = p.entry.orders[0]?.instrumentId;
    if (rule && instrument) out.push(expectedMoveExpr(instrument, rule.horizon));
  }
  return out;
}

/** The closes (at the Check Exit bar size, O144) the rule is checked against, on the run's price basis. */
export function expectedMoveCloses(
  def: StrategyDefinition,
  adjustment: Parameters<typeof stopCloseExpr>[1] = 'split_and_dividend',
) {
  const out: ReturnType<typeof stopCloseExpr>[] = [];
  for (const p of [def, ...(def.groups ?? [])]) {
    const instrument = p.entry.orders[0]?.instrumentId;
    if (expectedMoveRuleOf(p) && instrument)
      out.push(stopCloseExpr(instrument, adjustment, stopInterval(def)));
  }
  return out;
}

/** The fixed band: entry × (1 ± multiple × expected move). */
export function expectedMoveBand(
  entryPrice: Decimal,
  movePct: Decimal,
  multiple: string,
): { lower: Decimal; upper: Decimal } {
  const width = entryPrice.times(movePct).times(multiple);
  return { lower: entryPrice.minus(width), upper: entryPrice.plus(width) };
}

/**
 * Whether a close is beyond the band: past either edge, or only past the
 * edge in the position's favour ("gain") or against it ("loss").
 */
export function expectedMoveHit(
  close: Decimal,
  band: { lower: Decimal; upper: Decimal },
  side: ExpectedMoveRule['side'],
  long: boolean,
): boolean {
  const above = close.gt(band.upper);
  const below = close.lt(band.lower);
  if (side === 'either') return above || below;
  const gain = long ? above : below;
  return side === 'gain' ? gain : long ? below : above;
}
