import Decimal from 'decimal.js';
import { getIndicator, resolveIndicatorParams } from '../strategy/catalog';
import { barField, type Bar } from './bars';
import type { MarketField } from '../strategy/catalog';

/**
 * Indicator series over consecutive bars (Design v1.0 §6.4). Each returns one
 * value per input bar, `undefined` until enough history exists. Only bars at
 * or before an index contribute to its value, so no indicator can look ahead.
 */
export type IndicatorValues = (Decimal | undefined)[];

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

export function sma(xs: readonly Decimal[], n: number): IndicatorValues {
  const out: IndicatorValues = [];
  let sum = ZERO;
  xs.forEach((x, i) => {
    sum = sum.plus(x);
    const old = xs[i - n];
    if (old) sum = sum.minus(old);
    out.push(i >= n - 1 ? sum.div(n) : undefined);
  });
  return out;
}

/** Exponential average seeded with the simple average of the first `n` values. */
export function ema(xs: readonly Decimal[], n: number): IndicatorValues {
  const alpha = new Decimal(2).div(n + 1);
  const seed = sma(xs, n);
  const out: IndicatorValues = [];
  let prev: Decimal | undefined;
  xs.forEach((x, i) => {
    if (i < n - 1) out.push(undefined);
    else if (i === n - 1) out.push((prev = seed[i]));
    else
      out.push(
        (prev = x
          .minus(prev ?? x)
          .times(alpha)
          .plus(prev ?? x)),
      );
  });
  return out;
}

/** Wilder's smoothing: the first value is a simple average, then (prev·(n−1) + x)/n. */
function wilder(xs: readonly Decimal[], n: number, firstIndex: number): IndicatorValues {
  const out: IndicatorValues = xs.map(() => undefined);
  if (xs.length <= firstIndex + n - 1) return out;
  let avg = xs
    .slice(firstIndex, firstIndex + n)
    .reduce((a, b) => a.plus(b), ZERO)
    .div(n);
  out[firstIndex + n - 1] = avg;
  for (let i = firstIndex + n; i < xs.length; i++) {
    avg = avg
      .times(n - 1)
      .plus(xs[i] ?? ZERO)
      .div(n);
    out[i] = avg;
  }
  return out;
}

/** Relative strength index with Wilder's smoothing; 50 when prices did not move. */
export function rsi(xs: readonly Decimal[], n: number): IndicatorValues {
  const gains = xs.map((x, i) => (i === 0 ? ZERO : Decimal.max(x.minus(xs[i - 1] ?? x), 0)));
  const losses = xs.map((x, i) => (i === 0 ? ZERO : Decimal.max((xs[i - 1] ?? x).minus(x), 0)));
  const g = wilder(gains, n, 1);
  const l = wilder(losses, n, 1);
  return xs.map((_, i) => {
    const gain = g[i];
    const loss = l[i];
    if (gain === undefined || loss === undefined) return undefined;
    if (loss.isZero()) return gain.isZero() ? new Decimal(50) : HUNDRED;
    return HUNDRED.minus(HUNDRED.div(gain.div(loss).plus(1)));
  });
}

/** Average true range with Wilder's smoothing. */
export function atr(bars: readonly Bar[], n: number): IndicatorValues {
  const tr = bars.map((b, i) => {
    const prev = bars[i - 1];
    if (!prev) return b.high.minus(b.low);
    return Decimal.max(
      b.high.minus(b.low),
      b.high.minus(prev.close).abs(),
      b.low.minus(prev.close).abs(),
    );
  });
  return wilder(tr, n, 1);
}

/** Bollinger band from the simple average and the population standard deviation. */
export function bollinger(
  xs: readonly Decimal[],
  n: number,
  k: number,
  band: 'upper' | 'middle' | 'lower',
): IndicatorValues {
  const mid = sma(xs, n);
  return xs.map((_, i) => {
    const m = mid[i];
    if (m === undefined) return undefined;
    if (band === 'middle') return m;
    const window = xs.slice(i - n + 1, i + 1);
    const variance = window.reduce((a, x) => a.plus(x.minus(m).pow(2)), ZERO).div(n);
    const width = variance.sqrt().times(k);
    return band === 'upper' ? m.plus(width) : m.minus(width);
  });
}

function rolling(xs: readonly Decimal[], n: number, pick: 'max' | 'min'): IndicatorValues {
  return xs.map((_, i) => (i < n - 1 ? undefined : Decimal[pick](...xs.slice(i - n + 1, i + 1))));
}

export const highest = (xs: readonly Decimal[], n: number) => rolling(xs, n, 'max');
export const lowest = (xs: readonly Decimal[], n: number) => rolling(xs, n, 'min');

/** Percentage change over `n` bars. */
export function roc(xs: readonly Decimal[], n: number): IndicatorValues {
  return xs.map((x, i) => {
    const base = xs[i - n];
    if (base === undefined || base.isZero()) return undefined;
    return x.div(base).minus(1).times(HUNDRED);
  });
}

/**
 * Values of a catalog indicator over bars. `field` is the input series for
 * indicators that read one (ATR uses whole bars). Throws for an unknown name,
 * which validation rules out before a back test starts.
 */
export function indicatorSeries(
  name: string,
  params: Record<string, number | string>,
  bars: readonly Bar[],
  field: MarketField,
): IndicatorValues {
  const spec = getIndicator(name);
  if (!spec) throw new Error(`Unknown indicator ${name}`);
  const p = resolveIndicatorParams(spec, params);
  const n = Number(p.period);
  const xs = bars.map((b) => barField(b, field));
  switch (name) {
    case 'SMA':
      return sma(xs, n);
    case 'EMA':
      return ema(xs, n);
    case 'RSI':
      return rsi(xs, n);
    case 'ATR':
      return atr(bars, n);
    case 'BBANDS':
      return bollinger(xs, n, Number(p.stdDev), p.band as 'upper' | 'middle' | 'lower');
    case 'HIGHEST':
      return highest(xs, n);
    case 'LOWEST':
      return lowest(xs, n);
    case 'ROC':
      return roc(xs, n);
    default:
      throw new Error(`No implementation for indicator ${name}`);
  }
}
