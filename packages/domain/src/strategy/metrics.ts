import Decimal from 'decimal.js';
import {
  FUNDAMENTAL_MAX_AGE_DAYS,
  latestObservation,
  type FundamentalField,
  type FundamentalObservation,
  type FundamentalPoint,
} from '../market/point-in-time';
import type { IndicatorParamSpec, PriceAdjustment } from './catalog';
import type { IndicatorExpr, MarketExpr, MetricExpr, MetricRef } from './schema';

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
}

export interface MetricParamSpec extends Omit<IndicatorParamSpec, 'kind'> {
  /** `instrument` holds an instrument id, e.g. a benchmark. */
  kind: IndicatorParamSpec['kind'] | 'instrument';
}

export interface MetricSpec {
  id: string;
  label: string;
  /** One line for the builder's help text. */
  help: string;
  category: 'price' | 'fundamental';
  /** How a value reads: a fraction (0.12 is 12%), a plain number, or US dollars. */
  unit: 'fraction' | 'number' | 'usd';
  params: readonly MetricParamSpec[];
  /** Asset classes the metric can be computed for; the metric picker lists only these. */
  assetClasses: readonly string[];
  /** The daily series it reads, with enough history, for loading bars ahead of a run. */
  requirements(instrumentId: string, params: Record<string, number | string>): DailySeries[];
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
    id: 'rsi',
    label: 'RSI',
    help: 'The relative strength index on daily closes, as the RSI indicator computes it.',
    category: 'price',
    unit: 'number',
    params: [{ name: 'period', label: 'Period', kind: 'int', min: 2, max: 500, default: 14 }],
    assetClasses: PRICE_CLASSES,
    requirements: (id, p) => [dailyIndicator(id, 'RSI', Number(p.period ?? 14))],
    compute: (id, p, r, barsBack) =>
      r.value(dailyIndicator(id, 'RSI', Number(p.period ?? 14)), barsBack),
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

export const METRICS: readonly MetricSpec[] = [...PRICE_METRICS, ...FUNDAMENTAL_METRICS];

/** Whether a metric reads company filings (a company data feed is then needed). */
export function isFundamentalMetric(id: string): boolean {
  return getMetric(id)?.category === 'fundamental';
}

const BY_ID = new Map(METRICS.map((m) => [m.id, m]));

export function getMetric(id: string): MetricSpec | undefined {
  return BY_ID.get(id);
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
