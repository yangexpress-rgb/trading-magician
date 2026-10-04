import type { OrderSide, PhaseName } from '@tm/domain';

/** Bumped whenever simulation semantics change, so old results stay explainable (§7.2). */
export const ENGINE_VERSION = 'engine@1';

export const SHARPE_METHOD =
  'Mean daily return divided by the standard deviation of daily returns, times √252, with a zero risk-free rate. Needs at least 20 trading days.';

export interface BacktestFill {
  time: string;
  cycle: number;
  legId: string;
  legLabel: string;
  phase: PhaseName | 'flatten';
  instrumentId: string;
  symbol: string;
  side: OrderSide;
  quantity: string;
  price: string;
  commission: string;
  slippage: string;
}

export interface BacktestTradeLeg {
  legId: string;
  legLabel: string;
  phase: PhaseName | 'flatten';
  instrumentId: string;
  symbol: string;
  side: OrderSide;
  quantity: string;
  averagePrice: string | null;
}

export interface BacktestTrade {
  cycle: number;
  /** Closed: back to flat. Open: still holding when the test ended. Aborted: Entry never filled. */
  status: 'closed' | 'open' | 'aborted';
  entryTime: string | null;
  exitTime: string | null;
  legs: BacktestTradeLeg[];
  grossPnl: string;
  costs: string;
  netPnl: string;
  /** Net P/L as a percentage of the Entry value. */
  returnPct: string | null;
}

export interface EquityPoint {
  time: string;
  equity: string;
  cash: string;
  grossExposure: string;
  netExposure: string;
}

export interface InstrumentContribution {
  instrumentId: string;
  symbol: string;
  legs: string[];
  grossPnl: string;
  costs: string;
  netPnl: string;
  fills: number;
}

export interface BacktestWarning {
  code: string;
  message: string;
  count: number;
}

export interface BacktestMetrics {
  initialCapital: string;
  finalEquity: string;
  netReturnPct: string;
  grossReturnPct: string;
  maxDrawdownPct: string;
  /** Null when no cycle closed. */
  winRatePct: string | null;
  /** Null when there were no losing cycles (or no cycles). */
  profitFactor: string | null;
  sharpe: string | null;
  cycles: number;
  closedCycles: number;
  orders: number;
  fills: number;
  commission: string;
  slippage: string;
  borrow: string;
  averageExposurePct: string;
}

export interface BacktestResult {
  engineVersion: string;
  dataVersions: string[];
  assumptions: string[];
  sharpeMethod: string;
  metrics: BacktestMetrics;
  equity: EquityPoint[];
  trades: BacktestTrade[];
  fills: BacktestFill[];
  contributions: InstrumentContribution[];
  warnings: BacktestWarning[];
}
