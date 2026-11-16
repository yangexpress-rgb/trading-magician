import Decimal from 'decimal.js';

/**
 * The strategy trailing stop (N290, ADR 0099), shared by the back test and
 * paper execution. It watches the strategy as a whole, not each stock:
 *
 * - Tracking starts when the strategy holds positions and ends when it is flat
 *   again, so each run of holdings has its own best.
 * - The best is the highest strategy equity (capital, cash and holdings at
 *   their marks) seen while holding. Buying does not move equity, so adding a
 *   position does not look like a gain, and selling part of a position at a
 *   profit keeps that profit in equity, so it does not look like a loss.
 * - The stop fires when equity falls below that best by more than the limit %
 *   of the money in positions: the largest gross position value seen while
 *   holding. For one stock bought once, a 1% limit fires when the position has
 *   given back 1% of its value from its best.
 * - When it fires every position closes with market orders; until the
 *   strategy is flat again it stays fired and no new Entry is placed.
 *
 * Prices are checked once per pass (paper) or bar (back test), so a fast move
 * or a gap can lose more than the limit before the closing orders fill.
 */
export interface StrategyTrailState {
  /** Highest equity since the strategy last went from flat to holding. */
  bestEquity: string;
  /** Largest gross position value in that time: what the limit % is of. */
  invested: string;
  /** Set once the stop has fired, until the strategy is flat again (epoch ms). */
  firedAt?: number | undefined;
  /** Equity when it fired, for the notification and results. */
  firedEquity?: string | undefined;
}

export interface StrategyTrailInput {
  limitPct: string | undefined;
  state: StrategyTrailState | undefined;
  /** Strategy equity on this pass. */
  equity: Decimal;
  /** Gross value of what the strategy holds on this pass, at its marks. */
  gross: Decimal;
  /** Whether the strategy holds any position. */
  holding: boolean;
  now: number;
}

export interface StrategyTrailResult {
  state: StrategyTrailState | undefined;
  /** True only on the pass the stop fires. */
  fired: boolean;
  /** True while the stop has fired and positions are still closing. */
  closing: boolean;
}

export function stepStrategyTrail(input: StrategyTrailInput): StrategyTrailResult {
  const { limitPct, equity, gross, holding, now } = input;
  if (!limitPct || !holding) return { state: undefined, fired: false, closing: false };
  const prev = input.state;
  if (prev?.firedAt !== undefined) return { state: prev, fired: false, closing: true };
  const best = prev ? Decimal.max(prev.bestEquity, equity) : equity;
  const invested = prev ? Decimal.max(prev.invested, gross) : gross;
  const drop = best.minus(equity);
  const allowed = invested.times(limitPct).div(100);
  const state: StrategyTrailState = {
    bestEquity: best.toString(),
    invested: invested.toString(),
  };
  if (invested.gt(0) && drop.gt(allowed)) {
    state.firedAt = now;
    state.firedEquity = equity.toString();
    return { state, fired: true, closing: true };
  }
  return { state, fired: false, closing: false };
}

const money = (d: Decimal) =>
  `$${d.toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Why the stop fired, in words, for notifications and results. */
export function strategyTrailText(limitPct: string, state: StrategyTrailState): string {
  const best = new Decimal(state.bestEquity);
  const at = new Decimal(state.firedEquity ?? state.bestEquity);
  const invested = new Decimal(state.invested);
  return (
    `The strategy fell ${money(best.minus(at))} below its best since entry, more than ` +
    `${limitPct}% of the ${money(invested)} in its positions ` +
    `(${money(invested.times(limitPct).div(100))}), so every position was closed.`
  );
}
