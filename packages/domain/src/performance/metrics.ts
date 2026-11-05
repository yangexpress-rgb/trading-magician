import Decimal from 'decimal.js';

/**
 * Metrics shared by back tests and paper or live results (Design v1.0 §10.2,
 * §11; ADR 0021), so both are measured the same way.
 */

const ZERO = new Decimal(0);

/** Fewer daily returns than this and Sharpe is not shown (it means little). */
export const MIN_SHARPE_DAYS = 20;

/** Largest fall from a running peak, as a fraction of that peak. */
export function maxDrawdown(values: readonly Decimal[], start: Decimal): Decimal {
  let peak = start;
  let worst = ZERO;
  for (const v of values) {
    if (v.gt(peak)) peak = v;
    if (peak.gt(0)) {
      const dd = peak.minus(v).div(peak);
      if (dd.gt(worst)) worst = dd;
    }
  }
  return worst;
}

/** Daily returns from a series of closes, the first measured against `start`. */
export function dailyReturns(closes: readonly Decimal[], start: Decimal): Decimal[] {
  const returns: Decimal[] = [];
  let prev = start;
  for (const c of closes) {
    if (prev.gt(0)) returns.push(c.minus(prev).div(prev));
    prev = c;
  }
  return returns;
}

/** Annualised Sharpe of daily returns with a zero risk-free rate (252 sessions a year). */
export function sharpe(closes: readonly Decimal[], start: Decimal): Decimal | null {
  const returns = dailyReturns(closes, start);
  if (returns.length < MIN_SHARPE_DAYS) return null;
  const mean = returns.reduce((a, r) => a.plus(r), ZERO).div(returns.length);
  const variance = returns
    .reduce((a, r) => a.plus(r.minus(mean).pow(2)), ZERO)
    .div(returns.length - 1);
  if (variance.isZero()) return null;
  return mean.div(variance.sqrt()).times(new Decimal(252).sqrt());
}

/**
 * Time-weighted return: each day's return chained, so money added or taken
 * out (a flow, counted at the start of the day it happens) is not gain or loss.
 * Null until there is a day with something to measure against.
 */
export function timeWeightedReturn(
  points: readonly { equity: Decimal; flow?: Decimal | undefined }[],
  start: Decimal = ZERO,
): Decimal | null {
  const index = growthIndex(points, start);
  const last = index.at(-1);
  return last ? last.minus(1) : null;
}

/**
 * The growth of 1 invested at the start, day by day, with flows taken out. A
 * day with nothing invested at its start keeps the index where it was; days
 * before anything was invested are left out.
 */
export function growthIndex(
  points: readonly { equity: Decimal; flow?: Decimal | undefined }[],
  start: Decimal = ZERO,
): Decimal[] {
  const index: Decimal[] = [];
  let growth = new Decimal(1);
  let prev = start;
  let started = start.gt(0);
  for (const p of points) {
    const base = prev.plus(p.flow ?? ZERO);
    if (base.gt(0)) {
      growth = growth.times(p.equity.div(base));
      started = true;
    }
    if (started) index.push(growth);
    prev = p.equity;
  }
  return index;
}

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  /** Fraction of trades that made money; null with no trades. */
  winRate: Decimal | null;
  /** Gross profit over gross loss; null with no losing trade. */
  profitFactor: Decimal | null;
  averageNet: Decimal | null;
  /** Average of the winning trades, and of the losing ones (negative). */
  averageWin: Decimal | null;
  averageLoss: Decimal | null;
  best: Decimal | null;
  worst: Decimal | null;
}

/** Win rate, profit factor and the like over closed trades' net results. */
export function tradeStats(nets: readonly Decimal[]): TradeStats {
  const wins = nets.filter((n) => n.gt(0));
  const losing = nets.filter((n) => n.lt(0));
  const profit = wins.reduce((a, n) => a.plus(n), ZERO);
  const loss = losing.reduce((a, n) => a.plus(n.abs()), ZERO);
  const total = nets.reduce((a, n) => a.plus(n), ZERO);
  return {
    trades: nets.length,
    wins: wins.length,
    losses: losing.length,
    winRate: nets.length > 0 ? new Decimal(wins.length).div(nets.length) : null,
    profitFactor: loss.gt(0) ? profit.div(loss) : null,
    averageNet: nets.length > 0 ? total.div(nets.length) : null,
    averageWin: wins.length > 0 ? profit.div(wins.length) : null,
    averageLoss: losing.length > 0 ? loss.neg().div(losing.length) : null,
    best: nets.length > 0 ? Decimal.max(...nets) : null,
    worst: nets.length > 0 ? Decimal.min(...nets) : null,
  };
}
