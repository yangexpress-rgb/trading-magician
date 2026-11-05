import { maxDrawdown, nyDate, sharpe, tradeStats } from '@tm/domain';
import Decimal from 'decimal.js';
import type { BacktestMetrics, BacktestTrade, EquityPoint } from './results';

const HUNDRED = new Decimal(100);

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

/** The formulas are shared with paper and live results (ADR 0021). */
export { maxDrawdown, sharpe };

/** Equity at each session's last point, in time order. */
export function dailyCloses(equity: readonly EquityPoint[]): Decimal[] {
  const byDay = new Map<string, Decimal>();
  for (const p of equity) byDay.set(nyDate(p.time), new Decimal(p.equity));
  return [...byDay.values()];
}

export function computeMetrics(m: MetricsInput): BacktestMetrics {
  const last = m.equity.at(-1);
  const final = last ? new Decimal(last.equity) : m.initial;
  const costs = m.commission.plus(m.slippage).plus(m.borrow);
  const closes = dailyCloses(m.equity);
  const closed = m.trades.filter((t) => t.status === 'closed');
  const stats = tradeStats(closed.map((t) => new Decimal(t.netPnl)));
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
    winRatePct: stats.winRate ? pct(stats.winRate) : null,
    profitFactor: stats.profitFactor ? stats.profitFactor.toDecimalPlaces(2).toString() : null,
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
