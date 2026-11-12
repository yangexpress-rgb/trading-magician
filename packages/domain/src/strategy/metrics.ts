import Decimal from 'decimal.js';
import {
  FUNDAMENTAL_MAX_AGE_DAYS,
  latestObservation,
  type FundamentalField,
  type FundamentalObservation,
  type FundamentalPoint,
} from '../market/point-in-time';
import type { OptionSignalField, OptionSignalSource } from '../options/signals';
import type { EventMetricId, EventPoint } from '../events/signals';
import { isMlModelKey, type MlPrediction } from '../ml/predictions';
import {
  BAR_INTERVALS,
  type BarInterval,
  type IndicatorParamSpec,
  type PriceAdjustment,
} from './catalog';
import type { Expr, IndicatorExpr, MarketExpr, MetricExpr, MetricRef } from './schema';

/**
 * The shared metric registry (Design v1.2 principle 3, item 1). Each metric is
 * implemented once, here, and the same definition answers a condition value,
 * a Selection-group ranking and a screener column, so "6-month return" can
 * never mean three slightly different things.
 *
 * Every metric reads daily bars (split- and dividend-adjusted, regular
 * session) through a `SeriesResolver`, as of the bar being evaluated, so it
 * can't see the future (principle 2). When it can't be worked out, for lack
 * of history or a zero price, it is `undefined` ("null"), never zero
 * (principle 4): a null makes a condition false and leaves an instrument out
 * of a ranking.
 *
 * Fundamental metrics (item 6, ADR 0043) are in the same registry with
 * `category: 'fundamental'`: they combine the latest filing-backed value the
 * reader can see at that bar (point in time) with that day's price.
 *
 * Options metrics (options data brief v2 §6, ADR 0047) have `category:
 * 'options'`: each reads one field of the underlying's end-of-day options
 * signal, the latest one published by that bar's time and no more than 5
 * trading days old. They are condition inputs only; ranking and fire mode
 * don't offer them yet (Phase 2).
 */

/** Trading bars in a month of daily bars: 1, 3, 6 and 12 months are 21, 63, 126 and 252. */
export const BARS_PER_MONTH = 21;
/** Trading days in a year, for annualising daily volatility. */
export const TRADING_DAYS_PER_YEAR = 252;

/** Reads a daily series value `barsBack` bars before the bar being evaluated. */
export interface MetricReader {
  value(expr: MarketExpr | IndicatorExpr, barsBack: number): Decimal | undefined;
  /** A company's filing-backed value as known at that bar; absent without fundamentals. */
  fundamental?(
    instrumentId: string,
    field: FundamentalField,
    barsBack: number,
  ): FundamentalPoint | undefined;
  /** A series' value at an instant (its latest bar ending at or before it). */
  valueAt?(expr: MarketExpr | IndicatorExpr, timeMs: number): Decimal | undefined;
  /** An underlying's end-of-day options signal as known at that bar; absent without options data. */
  option?(
    instrumentId: string,
    field: OptionSignalField,
    barsBack: number,
  ): OptionPoint | undefined;
  /**
   * An earnings, deal or rate metric (free data feeds brief v1 §4) as known at
   * that bar; absent without event data.
   */
  event?(instrumentId: string, metric: EventMetricId, barsBack: number): EventPoint | undefined;
  /**
   * A model series' stored score for an instrument as known at that bar (ML
   * brief v1 §8): the latest prediction dated on or before it, no more than
   * 45 calendar days old; absent without prediction data.
   */
  ml?(instrumentId: string, modelKey: string, barsBack: number): MlPoint | undefined;
}

/** One stored model score, with the prediction and model run it came from (brief §10). */
export interface MlPoint {
  value: Decimal;
  modelKey: string;
  prediction: MlPrediction;
}

/** One options signal value, with the trading day it was worked out for. */
export interface OptionPoint {
  value: Decimal;
  /** The signal's as-of date (YYYY-MM-DD), shown in the condition log. */
  asOfDate: string;
  /** Recorded from the day's chain, or rebuilt from option bars (approximate). */
  source: OptionSignalSource;
}

export interface MetricParamSpec extends Omit<IndicatorParamSpec, 'kind'> {
  /** `instrument` holds an instrument id, e.g. a benchmark; `model` a model series key (ML brief §8). */
  kind: IndicatorParamSpec['kind'] | 'instrument' | 'model';
}

export interface MetricSpec {
  id: string;
  label: string;
  /** One line for the builder's help text. */
  help: string;
  category: 'price' | 'fundamental' | 'options' | 'earnings' | 'deals' | 'rates' | 'ml';
  /** How a value reads: a fraction (0.12 is 12%), a plain number, or US dollars. */
  unit: 'fraction' | 'number' | 'usd';
  params: readonly MetricParamSpec[];
  /** Asset classes the metric can be computed for; the metric picker lists only these. */
  assetClasses: readonly string[];
  /** The daily series it reads, with enough history, for loading bars ahead of a run. */
  requirements(instrumentId: string, params: Record<string, number | string>): DailySeries[];
  /**
   * A yes/no metric (1 yes, 0 no), such as Earnings window: its condition needs
   * nothing to compare with, so the builder offers "Not needed" (N216).
   */
  yesNo?: true;
  /** Problems with the resolved params beyond each one's own range, e.g. From after To. */
  checkParams?(params: Record<string, number | string>): string[];
  compute(
    instrumentId: string,
    params: Record<string, number | string>,
    r: MetricReader,
    barsBack: number,
  ): Decimal | undefined;
}

export type DailySeries = MarketExpr | IndicatorExpr;

/** Price metrics read daily closes, which indices have too (v1.2 item 5). */
const PRICE_CLASSES = ['stock', 'etf', 'index'] as const;

/** The daily close series of an instrument, `offset` bars back. */
export function dailyClose(
  instrumentId: string,
  offset = 0,
  adjustment: PriceAdjustment = 'split_and_dividend',
): MarketExpr {
  return {
    kind: 'market',
    id: `metric:close:${adjustment}:${instrumentId}`,
    instrumentId,
    field: 'close',
    interval: '1d',
    adjustment,
    session: 'regular',
    offset,
  };
}

/** The RSI series the `rsi` metric reads: closes at its interval, daily by default. */
function rsiSeries(instrumentId: string, p: Record<string, number | string>): IndicatorExpr {
  const interval = (BAR_INTERVALS as readonly string[]).includes(String(p.interval))
    ? (String(p.interval) as BarInterval)
    : '1d';
  return {
    ...dailyIndicator(instrumentId, 'RSI', Number(p.period ?? 14)),
    ...(interval !== '1d' ? { id: `metric:RSI:${interval}:${instrumentId}`, interval } : {}),
  };
}

function dailyIndicator(instrumentId: string, name: string, period: number): IndicatorExpr {
  return {
    kind: 'indicator',
    id: `metric:${name}:${instrumentId}`,
    name,
    params: { period },
    instrumentId,
    field: 'close',
    interval: '1d',
    adjustment: 'split_and_dividend',
    session: 'regular',
    offset: 0,
  };
}

const lookbackParam: MetricParamSpec = {
  name: 'lookbackMonths',
  label: 'Lookback (months)',
  kind: 'enum',
  options: ['1', '3', '6', '12'],
  default: '6',
};
const skipParam: MetricParamSpec = {
  name: 'skipMonths',
  label: 'Skip most recent (months)',
  kind: 'enum',
  options: ['0', '1'],
  default: '0',
};

const months = (v: number | string | undefined, fallback: number) => {
  const n = Number(v ?? fallback);
  return Number.isFinite(n) ? n : fallback;
};

/** Bars back to the start and end of a return window, e.g. 252 and 21 for 12-1. */
export function returnWindow(params: Record<string, number | string>): {
  from: number;
  to: number;
} {
  const lookback = months(params.lookbackMonths, 6) * BARS_PER_MONTH;
  const skip = months(params.skipMonths, 0) * BARS_PER_MONTH;
  return { from: lookback, to: skip };
}

/** `close(to bars ago) / close(from bars ago) − 1`, or undefined. */
function windowReturn(
  instrumentId: string,
  params: Record<string, number | string>,
  r: MetricReader,
  barsBack: number,
): Decimal | undefined {
  const { from, to } = returnWindow(params);
  const end = r.value(dailyClose(instrumentId), barsBack + to);
  const start = r.value(dailyClose(instrumentId), barsBack + from);
  if (!end || !start || start.lte(0)) return undefined;
  return end.div(start).minus(1);
}

/** Sample standard deviation (n − 1), or undefined with fewer than two values. */
export function sampleStdDev(xs: readonly Decimal[]): Decimal | undefined {
  if (xs.length < 2) return undefined;
  const mean = xs.reduce((a, x) => a.plus(x), new Decimal(0)).div(xs.length);
  const ss = xs.reduce((a, x) => a.plus(x.minus(mean).pow(2)), new Decimal(0));
  return ss.div(xs.length - 1).sqrt();
}

/** Population standard deviation (n), as the Bollinger band uses. */
export function populationStdDev(xs: readonly Decimal[]): Decimal | undefined {
  if (xs.length < 1) return undefined;
  const mean = xs.reduce((a, x) => a.plus(x), new Decimal(0)).div(xs.length);
  return xs
    .reduce((a, x) => a.plus(x.minus(mean).pow(2)), new Decimal(0))
    .div(xs.length)
    .sqrt();
}

const PRICE_METRICS: readonly MetricSpec[] = [
  {
    id: 'return',
    label: 'Return',
    help: 'close(today) / close(N bars ago) − 1 on daily bars; a month is 21 bars. Optionally skips the most recent month (12-1 momentum). 0.10 is 10%.',
    category: 'price',
    unit: 'fraction',
    params: [lookbackParam, skipParam],
    assetClasses: PRICE_CLASSES,
    requirements: (id, p) => [dailyClose(id, returnWindow(p).from)],
    compute: windowReturn,
  },
  {
    id: 'return_vs_benchmark',
    label: 'Return vs. benchmark',
    help: "The instrument's Return minus the benchmark's Return over the same window.",
    category: 'price',
    unit: 'fraction',
    params: [
      lookbackParam,
      skipParam,
      { name: 'benchmarkId', label: 'Benchmark', kind: 'instrument', default: '' },
    ],
    assetClasses: PRICE_CLASSES,
    requirements: (id, p) => {
      const from = returnWindow(p).from;
      const out = [dailyClose(id, from)];
      if (typeof p.benchmarkId === 'string' && p.benchmarkId)
        out.push(dailyClose(p.benchmarkId, from));
      return out;
    },
    compute: (id, p, r, barsBack) => {
      const bench = typeof p.benchmarkId === 'string' ? p.benchmarkId : '';
      if (!bench) return undefined;
      const own = windowReturn(id, p, r, barsBack);
      const other = windowReturn(bench, p, r, barsBack);
      return own && other ? own.minus(other) : undefined;
    },
  },
  {
    id: 'ma_distance',
    label: 'Moving-average distance',
    help: 'close / SMA(period) − 1 on daily bars. 0.05 is 5% above the average.',
    category: 'price',
    unit: 'fraction',
    params: [{ name: 'period', label: 'SMA period', kind: 'int', min: 2, max: 500, default: 200 }],
    assetClasses: PRICE_CLASSES,
    requirements: (id, p) => [dailyIndicator(id, 'SMA', Number(p.period ?? 200))],
    compute: (id, p, r, barsBack) => {
      const close = r.value(dailyClose(id), barsBack);
      const avg = r.value(dailyIndicator(id, 'SMA', Number(p.period ?? 200)), barsBack);
      if (!close || !avg || avg.isZero()) return undefined;
      return close.div(avg).minus(1);
    },
  },
  {
    id: 'volatility',
    label: 'Volatility',
    help: 'Sample standard deviation of daily returns over the window, annualised by √252. 0.20 is 20% a year.',
    category: 'price',
    unit: 'fraction',
    params: [
      { name: 'window', label: 'Window (bars)', kind: 'int', min: 2, max: 500, default: 60 },
    ],
    assetClasses: PRICE_CLASSES,
    requirements: (id, p) => [dailyClose(id, Number(p.window ?? 60))],
    compute: (id, p, r, barsBack) => {
      const n = Number(p.window ?? 60);
      const returns: Decimal[] = [];
      for (let k = 0; k < n; k++) {
        const today = r.value(dailyClose(id), barsBack + k);
        const before = r.value(dailyClose(id), barsBack + k + 1);
        if (!today || !before || before.lte(0)) return undefined;
        returns.push(today.div(before).minus(1));
      }
      return sampleStdDev(returns)?.times(new Decimal(TRADING_DAYS_PER_YEAR).sqrt());
    },
  },
  {
    // The one RSI (ADR 0049): conditions, ranking and the screener all read this.
    id: 'rsi',
    label: 'RSI',
    help: "The relative strength index (Wilder's smoothing) of the closes, on daily bars unless another interval is chosen.",
    category: 'price',
    unit: 'number',
    params: [
      { name: 'period', label: 'Period', kind: 'int', min: 1, max: 500, default: 14 },
      {
        name: 'interval',
        label: 'Bars',
        kind: 'enum',
        options: BAR_INTERVALS,
        default: '1d',
      },
    ],
    assetClasses: PRICE_CLASSES,
    requirements: (id, p) => [rsiSeries(id, p)],
    compute: (id, p, r, barsBack) => r.value(rsiSeries(id, p), barsBack),
  },
];

// ---------------------------------------------------------------------------
// Fundamental metrics (v1.2 item 6, ADR 0043)

/** Bars of daily history kept for working out a filing's share basis (about 15 months). */
const FILING_LOOKBACK_BARS = Math.ceil((FUNDAMENTAL_MAX_AGE_DAYS * 252) / 365) + 10;

/** Fundamentals are reported by companies: US stocks, not ETFs or indices. */
const COMPANY_CLASSES = ['stock'] as const;

const rawClose = (id: string, offset = 0) => dailyClose(id, offset, 'none');
const splitClose = (id: string, offset = 0) => dailyClose(id, offset, 'split_only');

/** Every fundamental metric reads the traded price and the split-adjusted one, far enough back. */
const fundamentalRequirements = (id: string): DailySeries[] => [
  rawClose(id, FILING_LOOKBACK_BARS),
  splitClose(id, FILING_LOOKBACK_BARS),
];

/**
 * How many of today's shares one share at `sinceMs` has become: 4 after a
 * 4-for-1 split in between, 1 without a split. It is the ratio of the traded
 * price to the split-adjusted price then, over the same ratio today. A
 * reader without price history (the screener's latest prices) has had no
 * split to report since the latest filing, and gives 1.
 */
export function sharesPerOldShare(
  instrumentId: string,
  sinceMs: number,
  r: MetricReader,
  barsBack: number,
): Decimal | undefined {
  if (!r.valueAt) return new Decimal(1);
  const rawNow = r.value(rawClose(instrumentId), barsBack);
  const adjNow = r.value(splitClose(instrumentId), barsBack);
  const rawThen = r.valueAt(rawClose(instrumentId), sinceMs);
  const adjThen = r.valueAt(splitClose(instrumentId), sinceMs);
  if (!rawNow || !adjNow || !rawThen || !adjThen || adjNow.isZero() || adjThen.isZero())
    return undefined;
  const now = rawNow.div(adjNow);
  if (now.isZero()) return undefined;
  return rawThen.div(adjThen).div(now);
}

interface FundamentalInputs {
  price: Decimal;
  get(field: FundamentalField): FundamentalPoint | undefined;
  /** A per-share value on today's share basis. */
  perShare(field: FundamentalField): Decimal | undefined;
  /** Market capitalisation: price × shares outstanding on today's basis. */
  marketCap(): Decimal | undefined;
}

function fundamentalInputs(
  id: string,
  r: MetricReader,
  barsBack: number,
): FundamentalInputs | undefined {
  if (!r.fundamental) return undefined;
  const price = r.value(rawClose(id), barsBack);
  if (!price || price.lte(0)) return undefined;
  const get = (field: FundamentalField) => r.fundamental?.(id, field, barsBack);
  return {
    price,
    get,
    perShare(field) {
      const p = get(field);
      if (!p) return undefined;
      const k = sharesPerOldShare(id, Date.parse(p.availableFrom), r, barsBack);
      return k && !k.isZero() ? p.value.div(k) : undefined;
    },
    marketCap() {
      const p = get('shares');
      if (!p || p.value.lte(0)) return undefined;
      const k = sharesPerOldShare(id, Date.parse(p.availableFrom), r, barsBack);
      return k ? price.times(p.value).times(k) : undefined;
    },
  };
}

function fundamentalMetric(
  id: string,
  label: string,
  help: string,
  unit: MetricSpec['unit'],
  compute: (f: FundamentalInputs) => Decimal | undefined,
): MetricSpec {
  return {
    id,
    label,
    help,
    category: 'fundamental',
    unit,
    params: [],
    assetClasses: COMPANY_CLASSES,
    requirements: (instrumentId) => fundamentalRequirements(instrumentId),
    compute: (instrumentId, _params, r, barsBack) => {
      const f = fundamentalInputs(instrumentId, r, barsBack);
      return f ? compute(f) : undefined;
    },
  };
}

const plain = (field: FundamentalField) => (f: FundamentalInputs) => f.get(field)?.value;
/** An optional balance-sheet amount: a company with none of it does not report it. */
const orZero = (f: FundamentalInputs, field: FundamentalField) =>
  f.get(field)?.value ?? new Decimal(0);

const FUNDAMENTAL_METRICS: readonly MetricSpec[] = [
  fundamentalMetric(
    'pe',
    'P/E ratio',
    'Price per share ÷ diluted EPS over the last twelve months. Unknown when EPS is zero or negative, so a loss-maker never looks cheap.',
    'number',
    (f) => {
      const eps = f.perShare('eps_ttm');
      return eps && eps.gt(0) ? f.price.div(eps) : undefined;
    },
  ),
  fundamentalMetric(
    'earnings_yield',
    'Earnings yield',
    'Diluted EPS over the last twelve months ÷ price per share. Negative for a loss. 0.05 is 5%.',
    'fraction',
    (f) => f.perShare('eps_ttm')?.div(f.price),
  ),
  fundamentalMetric(
    'dividend_yield',
    'Dividend yield',
    'Cash dividends declared per share over the last twelve months ÷ price per share. 0 for a company whose filings show earnings but no dividends paid in the last 15 months; unknown for one that pays cash dividends without reporting a per-share figure. 0.03 is 3%.',
    'fraction',
    (f) => f.perShare('dps_ttm')?.div(f.price),
  ),
  fundamentalMetric(
    'price_to_book',
    'Price-to-book',
    "Price per share ÷ book value per share (shareholders' equity ÷ shares outstanding, latest balance sheet). Unknown when equity is zero or negative.",
    'number',
    (f) => {
      const equity = f.get('equity')?.value;
      const cap = f.marketCap();
      return equity && cap && equity.gt(0) ? cap.div(equity) : undefined;
    },
  ),
  fundamentalMetric(
    'ev_ebitda',
    'EV/EBITDA',
    'Enterprise value (market cap + debt + preferred + minority interest − cash, latest balance sheet) ÷ EBITDA over the last twelve months (operating income + depreciation and amortization). Unknown when EBITDA is zero or negative.',
    'number',
    (f) => {
      const cap = f.marketCap();
      const cash = f.get('cash')?.value;
      const ebitda = f.get('ebitda_ttm')?.value;
      if (!cap || !cash || !ebitda || ebitda.lte(0)) return undefined;
      const ev = cap
        .plus(orZero(f, 'debt'))
        .plus(orZero(f, 'preferred'))
        .plus(orZero(f, 'minority_interest'))
        .minus(cash);
      return ev.div(ebitda);
    },
  ),
  fundamentalMetric(
    'dividend_streak',
    'Dividend-growth streak',
    'Consecutive years in which annual dividends per share rose over the year before, ending with the latest complete fiscal year.',
    'number',
    plain('dividend_streak'),
  ),
  fundamentalMetric(
    'revenue_ttm',
    'Revenue (TTM)',
    'Revenue over the last twelve months, as filed.',
    'usd',
    plain('revenue_ttm'),
  ),
  fundamentalMetric(
    'net_income_ttm',
    'Net income (TTM)',
    'Net income over the last twelve months, as filed.',
    'usd',
    plain('net_income_ttm'),
  ),
  fundamentalMetric(
    'eps_ttm',
    'EPS (TTM)',
    "Diluted earnings per share over the last twelve months, on today's share basis.",
    'number',
    (f) => f.perShare('eps_ttm'),
  ),
];

/** Options signals are recorded for US stocks and ETFs (brief §2). */
const OPTION_CLASSES = ['stock', 'etf'] as const;

/** The options metric id of a signal field, e.g. `options.iv30`. */
export const optionMetricId = (field: OptionSignalField) => `options.${field}`;

function optionsMetric(
  field: OptionSignalField,
  label: string,
  help: string,
  unit: MetricSpec['unit'],
): MetricSpec {
  return {
    id: optionMetricId(field),
    label,
    help,
    category: 'options',
    unit,
    params: [],
    assetClasses: OPTION_CLASSES,
    // The underlying's own daily closes date each bar back, as fundamentals do.
    requirements: (instrumentId) => [rawClose(instrumentId)],
    compute: (instrumentId, _params, r, barsBack) =>
      r.option?.(instrumentId, field, barsBack)?.value,
  };
}

const GEX_CAVEAT =
  'Assumes dealers are short every put and long every call, which nobody can check: a positioning gauge, not a measured dealer book.';

const OPTIONS_METRICS: readonly MetricSpec[] = [
  optionsMetric(
    'iv30',
    'IV30',
    "30-day implied volatility, annualised: the ATM IVs of the expiries either side of 30 days interpolated in variance. The app's own computation from the day's delayed chain. 0.20 is 20%.",
    'fraction',
  ),
  optionsMetric(
    'atm_iv',
    'ATM IV (nearest expiry)',
    'Mean of the at-the-money call and put implied volatility at the nearest expiry at least 2 days out. 0.20 is 20%.',
    'fraction',
  ),
  optionsMetric(
    'expected_move_1d_pct',
    'Expected move, 1 day (%)',
    'IV30 × √(1 ÷ 365): the one-standard-deviation move priced for one day, as a share of the price. 0.01 is 1%.',
    'fraction',
  ),
  optionsMetric(
    'expected_move_1d_usd',
    'Expected move, 1 day ($)',
    'Close × IV30 × √(1 ÷ 365), in dollars per share.',
    'usd',
  ),
  optionsMetric(
    'expected_move_5d_pct',
    'Expected move, 5 days (%)',
    'IV30 × √(5 ÷ 365): the one-standard-deviation move priced for a trading week, as a share of the price. 0.02 is 2%.',
    'fraction',
  ),
  optionsMetric(
    'expected_move_5d_usd',
    'Expected move, 5 days ($)',
    'Close × IV30 × √(5 ÷ 365), in dollars per share.',
    'usd',
  ),
  optionsMetric(
    'straddle_move_pct',
    'Straddle move (%)',
    'At-the-money call mid + put mid at the nearest expiry, ÷ the close: what the market charges for any move by that expiry. 0.03 is 3%.',
    'fraction',
  ),
  optionsMetric(
    'iv_rank_252d',
    'IV rank (1 year)',
    "Where today's IV30 sits between its 1-year low (0) and high (100). Unknown until 120 days of IV30 history exist.",
    'number',
  ),
  optionsMetric(
    'iv_percentile_252d',
    'IV percentile (1 year)',
    "Share of the last year's days (0–100) whose IV30 was at or below today's. Unknown until 120 days of IV30 history exist.",
    'number',
  ),
  optionsMetric(
    'iv_rv_ratio',
    'IV / realised volatility',
    'IV30 ÷ 20-day realised volatility. Above 1, options are priced rich against how the stock has moved; below 1, cheap.',
    'number',
  ),
  optionsMetric(
    'skew_30d',
    'Skew (25-delta, 30 days)',
    '30-day IV of the 25-delta put minus that of the 25-delta call. Positive when puts are priced richer (downside hedging). 0.04 is 4 volatility points.',
    'fraction',
  ),
  optionsMetric(
    'term_structure',
    'Term structure',
    'ATM IV at the nearest expiry at least 7 days out ÷ IV30. Above 1, near-term stress or an event is priced in (the app does not know earnings dates).',
    'number',
  ),
  optionsMetric(
    'put_call_volume',
    'Put/call volume ratio',
    'Put volume ÷ call volume at the nearest expiry, that day.',
    'number',
  ),
  optionsMetric(
    'put_call_oi',
    'Put/call open-interest ratio',
    'Put open interest ÷ call open interest at the nearest expiry.',
    'number',
  ),
  optionsMetric(
    'net_gex',
    'Net gamma exposure',
    `Call GEX − put GEX, in dollars of hedge flow per 1% move. Positive: moves tend to be damped; negative: amplified. ${GEX_CAVEAT}`,
    'usd',
  ),
  optionsMetric(
    'call_gex',
    'Call gamma exposure',
    `Σ call gamma × open interest × 100 × close² ÷ 100, in dollars per 1% move. ${GEX_CAVEAT}`,
    'usd',
  ),
  optionsMetric(
    'put_gex',
    'Put gamma exposure',
    `Σ put gamma × open interest × 100 × close² ÷ 100, in dollars per 1% move. ${GEX_CAVEAT}`,
    'usd',
  ),
];

function eventMetric(
  id: EventMetricId,
  category: 'earnings' | 'deals' | 'rates',
  label: string,
  help: string,
  unit: MetricSpec['unit'],
  assetClasses: readonly string[],
): MetricSpec {
  return {
    id,
    label,
    help,
    category,
    unit,
    params: [],
    assetClasses,
    // The instrument's own unadjusted daily closes date each bar back; the deal
    // spread compares the offer price with that close.
    requirements: (instrumentId) => [rawClose(instrumentId)],
    compute: (instrumentId, _params, r, barsBack) => r.event?.(instrumentId, id, barsBack)?.value,
  };
}

/** The widest earnings window, in trading days either side of the release. */
export const EARNINGS_WINDOW_MAX_DAYS = 20;

/**
 * Whether the bar falls within a range of NYSE trading days around an
 * earnings date (N189): 1 inside, 0 outside, unknown with no earnings dates
 * on record. Day 0 is the release day, −1 the trading day before, +1 the
 * trading day after. Past dates are EDGAR releases; coming ones are the
 * calendar feed's, with the actual release standing in before the feed began.
 */
function earningsWindowMetric(): MetricSpec {
  const day = (name: string, label: string, value: number): MetricParamSpec => ({
    name,
    label,
    kind: 'int',
    min: -EARNINGS_WINDOW_MAX_DAYS,
    max: EARNINGS_WINDOW_MAX_DAYS,
    default: value,
  });
  return {
    id: 'earnings.window',
    label: 'Earnings window',
    help: 'Whether the bar date is within the chosen range of trading days around an earnings release (weekends and market holidays skipped): 1 inside, 0 outside. Day 0 is the release day, −1 the trading day before, +1 the trading day after; −1 to +1 covers three trading days. It needs no comparison: with "Not needed" the condition holds inside the window. Coming dates come from the earnings calendar feed; in back tests before the feed began, the actual release date stands in. Unknown with no earnings dates on record.',
    category: 'earnings',
    unit: 'number',
    yesNo: true,
    params: [day('fromDay', 'From day (− before)', -1), day('toDay', 'To day (+ after)', 1)],
    assetClasses: ['stock'],
    requirements: (instrumentId) => [rawClose(instrumentId)],
    checkParams: (params) =>
      Number(params.fromDay) > Number(params.toDay) ? ['From day must not be after To day'] : [],
    compute: (instrumentId, params, r, barsBack) => {
      const from = Number(params.fromDay);
      const to = Number(params.toDay);
      const since = r.event?.(instrumentId, 'earnings.days_since_earnings', barsBack)?.value;
      const next = r.event?.(instrumentId, 'earnings.next_date_days', barsBack)?.value;
      if (since === undefined && next === undefined) return undefined;
      const inside = (offset: number) => offset >= from && offset <= to;
      const hit =
        (since !== undefined && inside(since.toNumber())) ||
        (next !== undefined && inside(-next.toNumber()));
      return new Decimal(hit ? 1 : 0);
    },
  };
}

/**
 * Earnings, deals and rates (free data feeds brief v1 §4, ADR 0058). Earnings
 * and deals come from the app's own record of EDGAR filings; the T-bill rate
 * from FRED. Each is the latest known on or before the bar.
 */
const EVENT_METRICS: readonly MetricSpec[] = [
  eventMetric(
    'earnings.days_since_earnings',
    'earnings',
    'Days since earnings',
    'Trading days from the latest earnings release (its 8-K, Item 2.02, on EDGAR) to the bar date, skipping weekends and market holidays: 0 on the release day, 1 on the next trading day (a Friday release is 1 on Monday). Unknown before the first release on record.',
    'number',
    ['stock'],
  ),
  earningsWindowMetric(),
  eventMetric(
    'earnings.sue_ts',
    'earnings',
    'Time-series SUE',
    'Standardised unexpected earnings of the latest release: (EPS this quarter − EPS the same quarter last year) ÷ the standard deviation of that difference over the 8 quarters before. Unknown until 8 prior differences exist.',
    'number',
    ['stock'],
  ),
  eventMetric(
    'earnings.surprise_pct',
    'earnings',
    'Earnings surprise (%)',
    'Reported EPS against the consensus estimate, (reported − estimated) ÷ |estimated|, for the latest release. Unknown without an earnings calendar feed that supplied an estimate. 0.05 is 5%.',
    'fraction',
    ['stock'],
  ),
  eventMetric(
    'earnings.next_earnings_days',
    'earnings',
    'Days to next earnings',
    'Trading days from the bar date to the next scheduled release, skipping weekends and market holidays: 0 on the release day, 1 the trading day before (a Monday release is 1 on the Friday before). From an earnings calendar feed; unknown without one (EDGAR-only mode).',
    'number',
    ['stock'],
  ),
  eventMetric(
    'deals.spread_pct',
    'deals',
    'Deal spread (%)',
    "(Offer price − close) ÷ close for the stock's latest active merger deal (announced or pending), from the app's tracker of EDGAR filings. Unknown without an active deal, a confirmed cash offer price, or after the deal closes or is withdrawn. 0.05 is 5%.",
    'fraction',
    ['stock'],
  ),
  eventMetric(
    'rates.tbill_3m',
    'rates',
    '3-month T-bill rate',
    "FRED's 3-month Treasury bill rate (DTB3) on or before the bar date, the same rate the options computation uses. 0.0412 is 4.12%. Compare a return with it for an absolute-momentum hurdle.",
    'fraction',
    PRICE_CLASSES,
  ),
];

/** The `ml.score` metric id (ML brief v1 §8). */
export const ML_SCORE_METRIC = 'ml.score';

/**
 * A model series' stored score (ML brief v1 §8, ADR 0086): frozen walk-forward
 * predictions written by the trainer, read point in time like options signals.
 * It reads no bars (a signal read, outside the N232 bar cap): a bar further
 * back is dated by the instrument's own daily closes when the run has them.
 */
const ML_METRICS: readonly MetricSpec[] = [
  {
    id: ML_SCORE_METRIC,
    label: 'ML score',
    help: "A model series' stored score for the stock (higher is more attractive), as of the latest prediction dated on or before the bar and no more than 45 calendar days old. Scores come from a model trained only on data whose outcomes were known before that date; the model never runs inside a back test. Unknown without a current score.",
    category: 'ml',
    unit: 'number',
    params: [{ name: 'modelKey', label: 'Model series', kind: 'model', default: '' }],
    assetClasses: ['stock'],
    requirements: () => [],
    compute: (instrumentId, params, r, barsBack) =>
      typeof params.modelKey === 'string' && params.modelKey
        ? r.ml?.(instrumentId, params.modelKey, barsBack)?.value
        : undefined,
  },
];

export const METRICS: readonly MetricSpec[] = [
  ...PRICE_METRICS,
  ...FUNDAMENTAL_METRICS,
  ...OPTIONS_METRICS,
  ...EVENT_METRICS,
  ...ML_METRICS,
];

/** Whether a metric reads stored model scores (ML brief v1 §8). */
export function isMlMetric(id: string): boolean {
  return getMetric(id)?.category === 'ml';
}

/** The model series key an `ml.score` reference reads, if it names one. */
export function mlModelKey(ref: { metric: string; params: Record<string, number | string> }) {
  if (!isMlMetric(ref.metric)) return undefined;
  const key = ref.params.modelKey;
  return typeof key === 'string' && key ? key : undefined;
}

/** Whether a metric reads earnings, deals or rates (event data the worker records, ADR 0058). */
export function isEventMetric(id: string): boolean {
  const c = getMetric(id)?.category;
  return c === 'earnings' || c === 'deals' || c === 'rates';
}

/** Whether a metric reads company filings (a company data feed is then needed). */
export function isFundamentalMetric(id: string): boolean {
  return getMetric(id)?.category === 'fundamental';
}

/** Whether a metric reads the end-of-day options signals (the options feed is then needed). */
export function isOptionsMetric(id: string): boolean {
  return getMetric(id)?.category === 'options';
}

/** The signal field an options metric reads, e.g. `iv30` for `options.iv30`. */
export function optionMetricField(id: string): OptionSignalField | undefined {
  return isOptionsMetric(id) ? (id.slice('options.'.length) as OptionSignalField) : undefined;
}

/**
 * Whether a metric can rank a Selection group or pick the best leg in fire
 * mode: every registry metric, options metrics included since Phase 2 of the
 * options brief (§10 item 10). A member without a value ranks as unknown.
 */
export function isRankingMetric(id: string): boolean {
  return getMetric(id) !== undefined;
}

const BY_ID = new Map(METRICS.map((m) => [m.id, m]));

export function getMetric(id: string): MetricSpec | undefined {
  return BY_ID.get(id);
}

/** Whether an expression is a yes/no metric, which needs nothing to compare with (N216). */
export function isYesNoExpr(expr: Expr | undefined): boolean {
  return expr?.kind === 'metric' && getMetric(expr.metric)?.yesNo === true;
}

/** Metrics the registry can compute for an asset class, for the metric picker. */
export function metricsFor(assetClass: string): MetricSpec[] {
  return METRICS.filter((m) => m.assetClasses.includes(assetClass));
}

/** Params with defaults filled in. */
export function resolveMetricParams(
  spec: MetricSpec,
  params: Record<string, number | string>,
): Record<string, number | string> {
  const out: Record<string, number | string> = { ...params };
  for (const p of spec.params) out[p.name] ??= p.default;
  return out;
}

/** A message per problem with a metric reference, or an empty list. */
export function checkMetricRef(ref: MetricRef): string[] {
  const spec = getMetric(ref.metric);
  if (!spec) return [`"${ref.metric}" is not a metric the app can compute`];
  const problems: string[] = [];
  const known = new Set(spec.params.map((p) => p.name));
  for (const key of Object.keys(ref.params)) {
    if (!known.has(key)) problems.push(`${spec.label} has no parameter "${key}"`);
  }
  const params = resolveMetricParams(spec, ref.params);
  for (const p of spec.params) {
    const v = params[p.name];
    if (p.kind === 'enum') {
      if (!p.options?.includes(String(v)))
        problems.push(`${p.label} must be one of ${p.options?.join(', ')}`);
    } else if (p.kind === 'instrument') {
      if (typeof v !== 'string' || !v) problems.push(`Choose the ${p.label.toLowerCase()}`);
    } else if (p.kind === 'model') {
      if (typeof v !== 'string' || !v) problems.push(`Choose the ${p.label.toLowerCase()}`);
      else if (!isMlModelKey(v)) problems.push(`"${v}" is not a model series key`);
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v))
        problems.push(`${p.label} must be a number`);
      else {
        if (p.kind === 'int' && !Number.isInteger(v))
          problems.push(`${p.label} must be a whole number`);
        if (p.min !== undefined && v < p.min) problems.push(`${p.label} must be at least ${p.min}`);
        if (p.max !== undefined && v > p.max) problems.push(`${p.label} must be at most ${p.max}`);
      }
    }
  }
  if (problems.length === 0 && spec.checkParams) problems.push(...spec.checkParams(params));
  return problems;
}

/** Instruments a metric reads besides its own, e.g. a benchmark. */
export function metricReferences(ref: MetricRef): string[] {
  const spec = getMetric(ref.metric);
  if (!spec) return [];
  return spec.params
    .filter((p) => p.kind === 'instrument')
    .map((p) => ref.params[p.name])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** The value of a metric for an instrument as of the bar `barsBack` bars ago. */
export function computeMetric(
  ref: MetricRef,
  instrumentId: string,
  r: MetricReader,
  barsBack = 0,
): Decimal | undefined {
  const spec = getMetric(ref.metric);
  if (!spec) return undefined;
  return spec.compute(instrumentId, resolveMetricParams(spec, ref.params), r, barsBack);
}

export function metricExprRef(e: MetricExpr): MetricRef {
  return { metric: e.metric, params: e.params };
}

/** Daily series a metric needs for an instrument, for loading bars. */
export function metricRequirements(ref: MetricRef, instrumentId: string): DailySeries[] {
  const spec = getMetric(ref.metric);
  if (!spec) return [];
  return spec.requirements(instrumentId, resolveMetricParams(spec, ref.params));
}

/** How a metric value reads to a person, e.g. "12.34%" or "47.1". */
export function formatMetric(ref: MetricRef, value: Decimal | undefined): string {
  if (!value) return '—';
  const spec = getMetric(ref.metric);
  if (spec?.unit === 'fraction') return `${value.times(100).toDecimalPlaces(2).toString()}%`;
  if (spec?.unit === 'usd') {
    const abs = value.abs();
    const [div, suffix] = abs.gte(1e9) ? [1e9, 'B'] : abs.gte(1e6) ? [1e6, 'M'] : [1, ''];
    return `${value.isNeg() ? '−' : ''}$${abs.div(div).toDecimalPlaces(2).toString()}${suffix}`;
  }
  return value.toDecimalPlaces(2).toString();
}

/**
 * A fundamental metric's value from a latest price and a company's stored
 * filings, as known at `asOfMs`: what the Research screener shows, through
 * the same registry definition strategies use (v1.2 item 6, principle 3).
 * The screener has no price history here, so no split is assumed between
 * the latest filing and now (design v1.2 open point O20).
 */
export function fundamentalSnapshot(
  metricId: string,
  price: number | null,
  observations: readonly FundamentalObservation[] | undefined,
  asOfMs: number,
): Decimal | undefined {
  if (price === null || !Number.isFinite(price) || !observations) return undefined;
  const last = new Decimal(price);
  const reader: MetricReader = {
    value: (expr) => (expr.kind === 'market' && expr.field === 'close' ? last : undefined),
    fundamental: (_id, field) => latestObservation(observations, field, asOfMs),
  };
  return computeMetric({ metric: metricId, params: {} }, 'screen', reader);
}
