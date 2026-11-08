import type {
  RiskSizing,
  ConditionNode,
  OrderSide,
  OrderType,
  Phase,
  PhaseName,
  PlannedOrder,
} from '@tm/domain';

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
  /** Which rule closed the cycle, for strategies using v1.2 rules. */
  exitReason?:
    'condition' | 'rebalance' | 'time_stop' | 'atr_stop' | 'expected_move' | 'trailing_stop';
  /** Two-sided strategies (v1.2 item 8): the direction and entry group of the trade. */
  direction?: 'long' | 'short';
  group?: string;
  /** Risk-based sizing (v1.2 item 9): equity, risk %, ATR at entry, stop distance, quantity. */
  sizing?: RiskSizing;
  /** ATR stop (v1.2 item 9): ATR at entry, average entry price and the fixed stop level. */
  atrStop?: {
    atr: string;
    atrMultiple: string;
    direction: 'long' | 'short';
    entryPrice: string;
    level: string;
  };
  /** Expected-move exit (ADR 0053): the move at entry and the fixed band. */
  expectedMove?: ExpectedMoveRecord;
}

export interface ExpectedMoveRecord {
  /** The expected move captured at entry, as a fraction of the price. */
  movePct: string;
  horizon: 1 | 5;
  multiple: string;
  side: 'either' | 'gain' | 'loss';
  direction: 'long' | 'short';
  entryPrice: string;
  lower: string;
  upper: string;
}

/**
 * One evaluation of a Selection group or of per-leg conditions (v1.2):
 * the table the engine ranked, so a rebalance can be checked by hand.
 * Rows are [symbol, metric value, pre-filter or leg condition, rank,
 * selected, why left out].
 */
export type SelectionRow = [
  string,
  string | null,
  boolean | null,
  number | null,
  boolean,
  string | null,
];

export interface SelectionRound {
  time: string;
  /** Scheduled period evaluated, e.g. "2025-03" for month end, or the day on a daily schedule. */
  period: string;
  /** The strategy-level Entry condition gating a Selection group; null when unknown. */
  gate?: boolean | null;
  rows: SelectionRow[];
  entered: string[];
  exited: string[];
  /** Entries were held back by the daily loss limit or drawdown. */
  halted?: boolean;
}

export interface SelectionLog {
  kind: 'ranking' | 'legs';
  metric: { metric: string; params: Record<string, number | string> } | null;
  direction: 'asc' | 'desc';
  schedule: string;
  exclusionLabels: Record<string, string>;
  rounds: SelectionRound[];
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

/** Three-valued truth as stored: null means unknown (missing data). */
export type StoredTruth = boolean | null;

/** One node of a condition tree on one bar. Groups carry only their truth. */
export interface ConditionCheck {
  id: string;
  truth: StoredTruth;
  /** Comparisons only: the values that were compared, null when unavailable. */
  left?: string | null;
  right?: string | null;
  upper?: string | null;
  /** Crosses only: the values one bar earlier. */
  prevLeft?: string | null;
  prevRight?: string | null;
  /**
   * Options metrics only (options brief v2 §5.3): the as-of date of each
   * end-of-day signal read, with "(rebuilt)"
   * after a date whose signal came from the approximate history rebuild.
   */
  optionsAsOf?: string[];
  /** The earnings, deal and rate records read, e.g. "earnings 2026-10-30" (ADR 0058). */
  eventsAsOf?: string[];
}

/**
 * Why a qualifying condition did or didn't act on a bar:
 * - fired: the trigger fired and orders were planned;
 * - confirming: true, but still inside the confirmation bars;
 * - cooldown: true, but inside the cooldown after the last firing;
 * - already_true: true on the previous bar too, and the trigger fires on the change only;
 * - fired_before: the trigger fires once per cycle and already did;
 * - cycle_open (Entry): fired, but a cycle was already open and re-entry is off or capped;
 * - daily_loss / drawdown (Entry): fired, but new entries were halted.
 */
export type ConditionOutcome =
  | 'fired'
  | 'confirming'
  | 'cooldown'
  | 'already_true'
  | 'fired_before'
  | 'cycle_open'
  | 'daily_loss'
  | 'drawdown';

export interface ConditionBar {
  /** The close of the bar the conditions were checked on. */
  time: string;
  /** Exit only: the cycle whose position the Exit was watching. */
  cycle?: number;
  truth: StoredTruth;
  outcome?: ConditionOutcome;
  checks: ConditionCheck[];
}

export interface ComparisonSummary {
  id: string;
  trueBars: number;
  falseBars: number;
  unknownBars: number;
  firstTrue: string | null;
  lastTrue: string | null;
}

export interface PhaseConditionReport {
  /** The rules that were tested, so the report reads without the strategy. */
  condition: ConditionNode;
  /** Absent for a slot's Exit, which has no trigger (ADR 0049). */
  trigger?: Phase['trigger'] | undefined;
  evaluated: number;
  trueBars: number;
  falseBars: number;
  unknownBars: number;
  fired: number;
  comparisons: ComparisonSummary[];
  /** Bar-by-bar checks, oldest first; see `barsTruncated`. */
  bars: ConditionBar[];
  /** Set when there were too many bars to keep: only bars that were true, fired or changed are kept. */
  barsTruncated: boolean;
}

export type OrderOutcome =
  'filled' | 'partial' | 'canceled' | 'rejected' | 'skipped' | 'working_at_end' | 'not_sent';

/** One planned order (leg) of one cycle: what was tried, and what came of it. */
export interface BacktestOrder {
  cycle: number;
  phase: PhaseName | 'flatten';
  legId: string;
  legLabel: string;
  instrumentId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  timeInForce: PlannedOrder['timeInForce'];
  outcome: OrderOutcome;
  /** Why it ended this way, as a code the UI words; null for a plain full fill. */
  reason: string | null;
  /** Figures behind the reason, e.g. the collar limit and how far the price moved. */
  detail: Record<string, string>;
  /** When the leg was due and sized (a bar close), or null if it never was. */
  decidedAt: string | null;
  /** When it could first fill: the decision time, or the next open if the market was closed. */
  activeFrom: string | null;
  endedAt: string | null;
  quantity: string | null;
  limitPrice: string | null;
  stopPrice: string | null;
  /** The last close when it was sent: the collar reference. */
  referencePrice: string | null;
  filledQuantity: string;
  averagePrice: string | null;
  fills: number;
  /** Bars it was working on before it ended. */
  barsWorking: number;
  /** The best price the market offered while it worked (lowest for a buy, highest for a sell). */
  bestPrice: string | null;
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
  /** How the Entry and Exit conditions evaluated. Absent on runs from before it was recorded. */
  conditions?: { entry: PhaseConditionReport; exit: PhaseConditionReport };
  /** The other entry groups' conditions (v1.2 item 8); `conditions` holds the first group's. */
  groupConditions?: {
    id: string;
    label: string;
    direction: 'long' | 'short';
    entry: PhaseConditionReport;
    exit: PhaseConditionReport;
    /** The group's own Entry and Exit leg ids, to tell its orders apart. */
    legIds: string[];
  }[];
  /** Every planned order of every cycle, in the order it was due. Absent on older runs. */
  orders?: BacktestOrder[];
  /** Symbols by instrument id, for wording conditions. */
  symbols?: Record<string, string>;
  /** Selection group rankings or per-leg selections, evaluation by evaluation (v1.2). */
  selections?: SelectionLog;
}
