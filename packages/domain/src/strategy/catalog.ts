/**
 * Vocabulary for strategy definitions: market fields, bar intervals and the
 * indicator catalog. The catalog is data, so adding an indicator does not
 * change the definition schema (Design v1.0 §6.4).
 */

export const MARKET_FIELDS = [
  'last',
  'bid',
  'ask',
  'mid',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'vwap',
] as const;
export type MarketField = (typeof MARKET_FIELDS)[number];

/** Quote fields come from the quotes feed; the rest from bars. */
export const QUOTE_FIELDS: readonly MarketField[] = ['last', 'bid', 'ask', 'mid'];

export const BAR_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;
export type BarInterval = (typeof BAR_INTERVALS)[number];

export const PRICE_ADJUSTMENTS = ['split_and_dividend', 'split_only', 'none'] as const;
export type PriceAdjustment = (typeof PRICE_ADJUSTMENTS)[number];

export const SESSIONS = ['regular', 'extended'] as const;
export type Session = (typeof SESSIONS)[number];

export interface IndicatorParamSpec {
  name: string;
  label: string;
  kind: 'int' | 'decimal' | 'enum';
  min?: number;
  max?: number;
  default: number | string;
  options?: readonly string[];
}

export interface IndicatorSpec {
  name: string;
  label: string;
  params: readonly IndicatorParamSpec[];
  /** Which input field the indicator reads; `null` means it uses OHLC bars itself. */
  defaultField: MarketField | null;
  /** Bars of history needed before the first value, given resolved params. */
  lookback: (params: Record<string, number | string>) => number;
  /**
   * "Bars ago" the builder starts a new expression with when this indicator is
   * picked (v1.2 item 7). Absent means 0. Saved expressions keep their own.
   */
  builderOffset?: number;
  /** Builder help text: which bars the value covers. */
  help?: string;
}

const period = (def: number, max = 1000): IndicatorParamSpec => ({
  name: 'period',
  label: 'Period',
  kind: 'int',
  min: 1,
  max,
  default: def,
});

export const INDICATORS: readonly IndicatorSpec[] = [
  {
    name: 'SMA',
    label: 'Simple moving average',
    params: [period(30)],
    defaultField: 'close',
    lookback: (p) => Number(p.period),
  },
  {
    name: 'EMA',
    label: 'Exponential moving average',
    params: [period(30)],
    defaultField: 'close',
    // Seeded with an SMA over the first period, then warmed up for stability.
    lookback: (p) => Number(p.period) * 3,
  },
  {
    name: 'RSI',
    label: 'Relative strength index',
    params: [period(14, 500)],
    defaultField: 'close',
    lookback: (p) => Number(p.period) + 1,
  },
  {
    name: 'ATR',
    label: 'Average true range',
    params: [period(14, 500)],
    defaultField: null,
    lookback: (p) => Number(p.period) + 1,
  },
  {
    name: 'BBANDS',
    label: 'Bollinger band',
    params: [
      period(20, 500),
      {
        name: 'stdDev',
        label: 'Standard deviations',
        kind: 'decimal',
        min: 0.1,
        max: 10,
        default: 2,
      },
      {
        name: 'band',
        label: 'Band',
        kind: 'enum',
        options: ['upper', 'middle', 'lower'],
        default: 'upper',
      },
    ],
    defaultField: 'close',
    lookback: (p) => Number(p.period),
  },
  {
    name: 'HIGHEST',
    label: 'Highest value',
    params: [period(20)],
    defaultField: 'high',
    lookback: (p) => Number(p.period),
    builderOffset: 1,
    help:
      'The highest value over the Period bars ending "Bars ago" bars before the bar being checked. ' +
      'With Bars ago 1 (the default) the current bar is left out, so "close is above Highest value(20) of high" ' +
      "means a close above the previous 20 bars' highest high: a breakout. With Bars ago 0 the window includes " +
      'the current bar, whose high is never below its own close, so that rule can never be true.',
  },
  {
    name: 'LOWEST',
    label: 'Lowest value',
    params: [period(20)],
    defaultField: 'low',
    lookback: (p) => Number(p.period),
    builderOffset: 1,
    help:
      'The lowest value over the Period bars ending "Bars ago" bars before the bar being checked. ' +
      'With Bars ago 1 (the default) the current bar is left out, so "close is below Lowest value(10) of low" ' +
      "means a close below the previous 10 bars' lowest low. With Bars ago 0 the window includes the current " +
      'bar, whose low is never above its own close, so that rule can never be true.',
  },
  {
    name: 'ROC',
    label: 'Rate of change (%)',
    params: [period(10)],
    defaultField: 'close',
    lookback: (p) => Number(p.period) + 1,
  },
];

const BY_NAME = new Map(INDICATORS.map((i) => [i.name, i]));

export function getIndicator(name: string): IndicatorSpec | undefined {
  return BY_NAME.get(name);
}

/** Fills missing params with defaults. Unknown params are kept so validation can report them. */
export function resolveIndicatorParams(
  spec: IndicatorSpec,
  params: Record<string, number | string>,
): Record<string, number | string> {
  const resolved: Record<string, number | string> = { ...params };
  for (const p of spec.params) resolved[p.name] ??= p.default;
  return resolved;
}

/** Returns a message for each problem with the given params, or an empty list. */
export function checkIndicatorParams(
  spec: IndicatorSpec,
  params: Record<string, number | string>,
): string[] {
  const problems: string[] = [];
  const known = new Set(spec.params.map((p) => p.name));
  for (const key of Object.keys(params)) {
    if (!known.has(key)) problems.push(`${spec.name} has no parameter "${key}"`);
  }
  for (const p of spec.params) {
    const value = params[p.name];
    if (value === undefined) {
      problems.push(`${p.label} is required for ${spec.name}`);
      continue;
    }
    if (p.kind === 'enum') {
      if (typeof value !== 'string' || !p.options?.includes(value)) {
        problems.push(`${p.label} must be one of ${p.options?.join(', ')}`);
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${p.label} must be a number`);
      continue;
    }
    if (p.kind === 'int' && !Number.isInteger(value))
      problems.push(`${p.label} must be a whole number`);
    if (p.min !== undefined && value < p.min) problems.push(`${p.label} must be at least ${p.min}`);
    if (p.max !== undefined && value > p.max) problems.push(`${p.label} must be at most ${p.max}`);
  }
  return problems;
}
