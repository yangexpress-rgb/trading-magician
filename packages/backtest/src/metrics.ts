import { nyDate } from '@tm/domain';
import Decimal from 'decimal.js';
import type { BacktestMetrics, BacktestTrade, EquityPoint } from './results';

const HUNDRED = new Decimal(100);
const MIN_SHARPE_DAYS = 20;

export interface MetricsInput {
  initial: Decimal;
  equity: readonly EquityPoint[];
  trades: readonly BacktestTrade[];
  orders: number;
  fills: number;
  commission: Decimal;
  slippage: Decimal;
  borrow: Decimal;
}

const pct = (d: Decimal) => d.times(HUNDRED).toDecimalPlaces(2).toString();

/** Equity at each session's last point, in time order. */
export function dailyCloses(equity: readonly EquityPoint[]): Decimal[] {
  const byDay = new Map<string, Decimal>();
  for (const p of equity) byDay.set(nyDate(p.time), new Decimal(p.equity));
  return [...byDay.values()];
}

/** Largest fall from a running peak, as a fraction of that peak. */
export function maxDrawdown(values: readonly Decimal[], start: Decimal): Decimal {
  let peak = start;
  let worst = new Decimal(0);
  for (const v of values) {
    if (v.gt(peak)) peak = v;
    if (peak.gt(0)) {
      const dd = peak.minus(v).div(peak);
      if (dd.gt(worst)) worst = dd;
    }
  }
  return worst;
}

/** Annualised Sharpe of daily returns with a zero risk-free rate (see SHARPE_METHOD). */
export function sharpe(closes: readonly Decimal[], start: Decimal): Decimal | null {
  const returns: Decimal[] = [];
  let prev = start;
  for (const c of closes) {
    if (prev.gt(0)) returns.push(c.minus(prev).div(prev));
    prev = c;
  }
  if (returns.length < MIN_SHARPE_DAYS) return null;
  const mean = returns.reduce((a, r) => a.plus(r), new Decimal(0)).div(returns.length);
  const variance = returns
    .reduce((a, r) => a.plus(r.minus(mean).pow(2)), new Decimal(0))
    .div(returns.length - 1);
  if (variance.isZero()) return null;
  return mean.div(variance.sqrt()).times(new Decimal(252).sqrt());
}

export function computeMetrics(m: MetricsInput): BacktestMetrics {
  const last = m.equity.at(-1);
  const final = last ? new Decimal(last.equity) : m.initial;
  const costs = m.commission.plus(m.slippage).plus(m.borrow);
  const closes = dailyCloses(m.equity);
  const closed = m.trades.filter((t) => t.status === 'closed');
  const wins = closed.filter((t) => new Decimal(t.netPnl).gt(0));
  const profit = closed.reduce(
    (a, t) => Decimal.max(new Decimal(t.netPnl), 0).plus(a),
    new Decimal(0),
  );
  const loss = closed.reduce(
    (a, t) => Decimal.min(new Decimal(t.netPnl), 0).abs().plus(a),
    new Decimal(0),
  );
  const exposures = m.equity
    .map((p) => ({ gross: new Decimal(p.grossExposure), equity: new Decimal(p.equity) }))
    .filter((p) => p.equity.gt(0))
    .map((p) => p.gross.div(p.equity));
  const avgExposure =
    exposures.length > 0
      ? exposures.reduce((a, e) => a.plus(e), new Decimal(0)).div(exposures.length)
      : new Decimal(0);
  const s = sharpe(closes, m.initial);
  return {
    initialCapital: m.initial.toDecimalPlaces(2).toString(),
    finalEquity: final.toDecimalPlaces(2).toString(),
    netReturnPct: pct(final.minus(m.initial).div(m.initial)),
    grossReturnPct: pct(final.plus(costs).minus(m.initial).div(m.initial)),
    maxDrawdownPct: pct(
      maxDrawdown(
        m.equity.map((p) => new Decimal(p.equity)),
        m.initial,
      ),
    ),
    winRatePct: closed.length > 0 ? pct(new Decimal(wins.length).div(closed.length)) : null,
    profitFactor: loss.gt(0) ? profit.div(loss).toDecimalPlaces(2).toString() : null,
    sharpe: s ? s.toDecimalPlaces(2).toString() : null,
    cycles: m.trades.filter((t) => t.status !== 'aborted').length,
    closedCycles: closed.length,
    orders: m.orders,
    fills: m.fills,
    commission: m.commission.toDecimalPlaces(2).toString(),
    slippage: m.slippage.toDecimalPlaces(2).toString(),
    borrow: m.borrow.toDecimalPlaces(2).toString(),
    averageExposurePct: pct(avgExposure),
  };
}
