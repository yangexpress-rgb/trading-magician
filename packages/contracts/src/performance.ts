import { z } from 'zod';

/**
 * Performance from reconciled fills and stored valuations (Design v1.0 §10,
 * §14.3; ADRs 0019 to 0021). Money is USD, as strings to two places;
 * percentages are strings to two places; dates are NYSE session dates.
 */

export const PERFORMANCE_ASSET_CLASSES = [
  'stock',
  'etf',
  'option',
  'future',
  'forex',
  'crypto',
] as const;

const many = <T extends z.ZodType>(item: T) =>
  z
    .union([item, z.array(item)])
    .transform((v) => (Array.isArray(v) ? v : [v]) as z.output<T>[])
    .optional();

/** Filters shared by /performance/summary, /timeseries and /trades. Repeat a key for several. */
export const performanceQuery = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    accountId: many(z.uuid()),
    strategyId: many(z.uuid()),
    versionId: many(z.uuid()),
    instrumentId: many(z.uuid()),
    assetClass: many(z.enum(PERFORMANCE_ASSET_CLASSES)),
    mode: z.enum(['paper', 'live']).default('paper'),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The start date must be on or before the end date',
    path: ['to'],
  });
export type PerformanceQuery = z.input<typeof performanceQuery>;

export interface PositionDifferenceDto {
  instrumentId: string;
  symbol: string;
  app: string;
  broker: string;
}

export interface BrokerDifferenceDto {
  accountId: string;
  accountName: string;
  sessionDate: string;
  appEquity: string | null;
  brokerEquity: string | null;
  /** Broker less app; null when the broker reports no equity. */
  equityDifference: string | null;
  /** Holdings that differ: those the app did not trade are "outside the app". */
  positions: PositionDifferenceDto[];
}

export interface PerformanceSummaryDto {
  currency: 'USD';
  from: string | null;
  to: string | null;
  /** True when a strategy, version, instrument or asset class narrows the view: no account equity then. */
  filtered: boolean;
  equity: {
    start: string | null;
    end: string | null;
    /** Daily time-weighted. */
    returnPct: string | null;
    maxDrawdownPct: string | null;
    sharpe: string | null;
    /** What the brokers report for the same accounts at their latest valuation, when all do; it counts. */
    brokerEnd: string | null;
  };
  /** Sessions in the range with a valuation; under 20 makes drawdown and Sharpe weak. */
  sessions: number;
  shortHistory: boolean;
  /** Gross is before fees; net after. */
  pnl: { net: string; gross: string; realized: string; unrealized: string; fees: string };
  /** What is held at the last session in range, and as a share of equity (account view only). */
  exposure: { gross: string; pctOfEquity: string | null };
  /** The value of every fill in range, and as a share of average equity (account view only). */
  turnover: { traded: string; pctOfEquity: string | null };
  /** Most capital at work on any day, and net over it. */
  peakCapital: string;
  returnOnPeakCapitalPct: string | null;
  trades: {
    count: number;
    open: number;
    closed: number;
    wins: number;
    losses: number;
    winRatePct: string | null;
    profitFactor: string | null;
    averageNet: string | null;
    averageWin: string | null;
    averageLoss: string | null;
    best: string | null;
    worst: string | null;
  };
  /** One row per strategy and account it ran on (N309): "this strategy, on this account". */
  byStrategy: {
    strategyId: string;
    strategyName: string;
    /** The strategy's own S number (ADR 0066); null if it has none. */
    strategyNumber: string | null;
    accountId: string;
    accountName: string;
    accountMode: 'paper' | 'live';
    net: string;
    closedTrades: number;
    peakCapital: string;
    returnOnPeakCapitalPct: string | null;
    /** P/L over today's NYSE session, and its % of the capital at work then (N296). */
    todayPnl: string;
    todayPct: string | null;
  }[];
  byAsset: { instrumentId: string; symbol: string; assetClass: string; net: string }[];
  /**
   * Today's results (N296): the current NYSE session, or the last one before
   * the open, whatever From and To say; the other filters apply. The % is the
   * account's time-weighted change in equity, or, in a narrowed view, P/L over
   * the capital at work that session.
   */
  today: { sessionDate: string; pnl: string; pct: string | null };
  /** Asset classes this person has traded, from the instrument store: the filter's choices (v1.2 item 10). */
  assetClasses: string[];
  dataQuality: {
    lastValuedAt: string | null;
    /** Open holdings valued at a stale or missing price at the last valuation. */
    staleMarks: number;
    differences: BrokerDifferenceDto[];
  };
}

export interface PerformancePointDto {
  date: string;
  /** Account equity; null when the view is filtered. */
  equity: string | null;
  /** Profit or loss since the start of the range. */
  pnl: string;
  /** Below the running peak: of equity when there is equity, else of P&L in dollars. */
  drawdown: string;
  drawdownPct: string | null;
  final: boolean;
}

export interface PerformanceTimeseriesDto {
  currency: 'USD';
  filtered: boolean;
  points: PerformancePointDto[];
}

export interface PerformanceTradeLegDto {
  legLabel: string;
  accountId: string;
  accountName: string;
  instrumentId: string;
  symbol: string;
  side: 'long' | 'short';
  opened: string;
  closed: string;
  averageOpen: string;
  averageClose: string | null;
  gross: string;
  fees: string;
  net: string;
}

export interface PerformanceTradeDto {
  cycleId: string;
  seq: number;
  strategyId: string;
  strategyName: string;
  strategyNumber: string | null;
  versionNo: number;
  runtimeId: string;
  mode: 'paper' | 'live';
  openedAt: string;
  closedAt: string | null;
  gross: string;
  fees: string;
  net: string;
  capital: string;
  returnPct: string | null;
  legs: PerformanceTradeLegDto[];
}

export interface PerformanceTradesDto {
  currency: 'USD';
  trades: PerformanceTradeDto[];
}
