import Decimal from 'decimal.js';
import {
  computeMetric,
  metricExprRef,
  populationStdDev,
  sampleStdDev,
  type MlPoint,
  type OptionPoint,
} from './metrics';
import type { FundamentalField, FundamentalPoint } from '../market/point-in-time';
import type { OptionSignalField } from '../options/signals';
import type { EventMetricId, EventPoint } from '../events/signals';
import type { SessionBars } from './session-metrics';
import type {
  Comparison,
  ConditionNode,
  Expr,
  IndicatorExpr,
  MarketExpr,
  PositionExpr,
  StatExpr,
} from './schema';

/**
 * Stands for "this leg's instrument" or "this universe member" (v1.2 items 1
 * and 2). Expressions in a leg condition, a Selection group's pre-filter and
 * its Exit rules may name it; the engine binds it to the instrument being
 * evaluated with `withContext`. It is the nil UUID, so every schema that
 * takes an instrument id accepts it and no stored id can collide with it.
 */
export const CONTEXT_INSTRUMENT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Pure evaluation of conditions against market values (Design v1.0 §6.5 steps
 * 4–5). The same code runs in the Strategy Lab preview, the Phase 2 back tester
 * and the Phase 3 runtime, so rule semantics can't drift between them.
 *
 * Missing or unusable data yields `undefined` ("unknown"), and an unknown
 * condition never qualifies. Logic is three-valued: AND is false if any child
 * is false, OR is true if any child is true, otherwise unknown propagates.
 */

export type SeriesExpr = MarketExpr | IndicatorExpr;

/** What the current cycle holds in one instrument, from its Entry fills. */
export interface PositionSnapshot {
  /** Signed: positive long, negative short. */
  quantity: Decimal;
  /** Average price of the cycle's Entry fills, before fees. */
  averagePrice: Decimal;
  /**
   * The best close since Entry filled (highest for a long, lowest for a
   * short), from the entry price, and the close it was last checked with
   * (N217). The engines keep them at the Check Exit bar size.
   */
  peak?: Decimal | undefined;
  /** The latest close at the Check Exit bar size, on the run's price basis. */
  checkClose?: Decimal | undefined;
  /** When that close's bar ended (ms), for the back test's cycle card (N224). */
  checkCloseAt?: number | undefined;
  /** When Entry first filled (ms), for the back test's cycle card (N224). */
  openedAt?: number | undefined;
  /** Trading days since Entry first filled, counting that day (N221). */
  daysHeld?: number | undefined;
  /**
   * Whole minutes from the cycle's earliest Entry fill to the evaluation: the
   * current bar's end in back tests, the pass time on paper (N254).
   */
  minutesHeld?: number | undefined;
  /** ATR(period) of daily bars when Entry was decided, by period (N221). */
  atrAtEntry?: Readonly<Record<number, Decimal>> | undefined;
  /** The options expected move (a fraction) over 1 or 5 days when Entry was decided (N221). */
  moveAtEntry?: Readonly<Partial<Record<1 | 5, Decimal>>> | undefined;
}

export interface SeriesResolver {
  /** Value of a series `barsBack` bars before the expression's own offset, or undefined. */
  value(expr: SeriesExpr, barsBack: number): Decimal | undefined;
  /** Whether the latest value is older than the strategy's stale-data threshold. */
  isStale(expr: SeriesExpr): boolean;
  /**
   * The cycle's position in an instrument, or undefined when there is none.
   * Resolvers without a cycle (Entry rules, previews) leave it out.
   */
  position?(instrumentId: string): PositionSnapshot | undefined;
  /**
   * A company's fundamental value as known at the bar `barsBack` bars ago
   * (v1.2 item 6): the latest observation whose filing was accepted by then.
   * Resolvers without fundamentals leave it out, and such metrics are unknown.
   */
  fundamental?(
    instrumentId: string,
    field: FundamentalField,
    barsBack: number,
  ): FundamentalPoint | undefined;
  /** A series' value at an instant: its latest bar ending at or before it. */
  valueAt?(expr: SeriesExpr, timeMs: number): Decimal | undefined;
  /**
   * An underlying's end-of-day options signal as known at the bar `barsBack`
   * bars ago (options data brief v2 §5.3): the latest one published by then,
   * no more than 5 trading days old. Resolvers without options data leave it
   * out, and options metrics are unknown.
   */
  option?(
    instrumentId: string,
    field: OptionSignalField,
    barsBack: number,
  ): OptionPoint | undefined;
  /** An earnings, deal or rate value as known at that bar (free data feeds brief v1 §6). */
  event?(instrumentId: string, metric: EventMetricId, barsBack: number): EventPoint | undefined;
  /** A model series' stored score as known at that bar (ML brief v1 §8). */
  ml?(instrumentId: string, modelKey: string, barsBack: number): MlPoint | undefined;
  /** When the bar `value` reads ended (ms), for explaining a check (N224). */
  barEnd?(expr: SeriesExpr, barsBack: number): number | undefined;
  /** Today's completed regular-session bars, for session values (N253). */
  session?(instrumentId: string, barsBack: number): SessionBars | undefined;
}

/** The bar series a position expression is marked against: its interval's close. */
export function markExpr(e: PositionExpr): MarketExpr {
  return {
    kind: 'market',
    id: e.id,
    instrumentId: e.instrumentId,
    field: 'close',
    interval: e.interval,
    adjustment: e.adjustment,
    session: e.session,
    offset: 0,
  };
}

/** The series an expression reads from, if any: itself, or a position's mark. */
export function seriesOf(e: Expr): SeriesExpr | undefined {
  if (e.kind === 'market' || e.kind === 'indicator') return e;
  if (e.kind === 'position') return markExpr(e);
  return undefined;
}

/** A resolver that reads `CONTEXT_INSTRUMENT_ID` as `instrumentId`. */
export function withContext(r: SeriesResolver, instrumentId: string): SeriesResolver {
  const bind = <T extends SeriesExpr>(e: T): T =>
    e.instrumentId === CONTEXT_INSTRUMENT_ID ? { ...e, instrumentId } : e;
  const bindId = (id: string) => (id === CONTEXT_INSTRUMENT_ID ? instrumentId : id);
  return {
    value: (expr, barsBack) => r.value(bind(expr), barsBack),
    isStale: (expr) => r.isStale(bind(expr)),
    ...(r.fundamental
      ? {
          fundamental: (id: string, field: FundamentalField, barsBack: number) =>
            r.fundamental?.(bindId(id), field, barsBack),
        }
      : {}),
    ...(r.valueAt ? { valueAt: (expr: SeriesExpr, t: number) => r.valueAt?.(bind(expr), t) } : {}),
    ...(r.barEnd
      ? { barEnd: (expr: SeriesExpr, barsBack: number) => r.barEnd?.(bind(expr), barsBack) }
      : {}),
    ...(r.option
      ? {
          option: (id: string, field: OptionSignalField, barsBack: number) =>
            r.option?.(bindId(id), field, barsBack),
        }
      : {}),
    ...(r.event
      ? {
          event: (id: string, metric: EventMetricId, barsBack: number) =>
            r.event?.(bindId(id), metric, barsBack),
        }
      : {}),
    ...(r.ml
      ? {
          ml: (id: string, key: string, barsBack: number) => r.ml?.(bindId(id), key, barsBack),
        }
      : {}),
    ...(r.session
      ? { session: (id: string, barsBack: number) => r.session?.(bindId(id), barsBack) }
      : {}),
    ...(r.position
      ? {
          position: (id: string) => r.position?.(id === CONTEXT_INSTRUMENT_ID ? instrumentId : id),
        }
      : {}),
  };
}

/** A resolver that also answers for one cycle's positions. */
export function withPositions(
  r: SeriesResolver,
  position: (instrumentId: string) => PositionSnapshot | undefined,
): SeriesResolver {
  return {
    value: (expr, barsBack) => r.value(expr, barsBack),
    isStale: (expr) => r.isStale(expr),
    ...(r.fundamental
      ? {
          fundamental: (id: string, field: FundamentalField, barsBack: number) =>
            r.fundamental?.(id, field, barsBack),
        }
      : {}),
    ...(r.valueAt ? { valueAt: (expr: SeriesExpr, t: number) => r.valueAt?.(expr, t) } : {}),
    ...(r.barEnd
      ? { barEnd: (expr: SeriesExpr, barsBack: number) => r.barEnd?.(expr, barsBack) }
      : {}),
    ...(r.option
      ? {
          option: (id: string, field: OptionSignalField, barsBack: number) =>
            r.option?.(id, field, barsBack),
        }
      : {}),
    ...(r.event
      ? {
          event: (id: string, metric: EventMetricId, barsBack: number) =>
            r.event?.(id, metric, barsBack),
        }
      : {}),
    ...(r.ml
      ? { ml: (id: string, key: string, barsBack: number) => r.ml?.(id, key, barsBack) }
      : {}),
    ...(r.session ? { session: (id: string, barsBack: number) => r.session?.(id, barsBack) } : {}),
    position,
  };
}

const HUNDRED = new Decimal(100);
/** The ATR period "Below entry, in ATRs at entry" reads when it names none. */
export const DEFAULT_HOLDING_ATR_PERIOD = 20;

function positionValue(e: PositionExpr, r: SeriesResolver, barsBack: number): Decimal | undefined {
  const p = r.position?.(e.instrumentId);
  const held = p && !p.quantity.isZero() ? p : undefined;
  if (e.field === 'quantity') return held ? held.quantity : new Decimal(0);
  if (!held) return undefined;
  if (e.field === 'entry_price') return held.averagePrice;
  // The trailing stop as a value (N217): percent off the best close since entry.
  if (e.field === 'off_peak_pct') {
    if (!held.peak || !held.checkClose || held.peak.isZero()) return undefined;
    const off = held.peak.minus(held.checkClose).div(held.peak).times(HUNDRED);
    return held.quantity.isNegative() ? off.negated() : off;
  }
  // The holding-period exit as a value (N221).
  if (e.field === 'days_held')
    return held.daysHeld === undefined ? undefined : new Decimal(held.daysHeld);
  // The intraday time stop as a value (N254).
  if (e.field === 'minutes_held')
    return held.minutesHeld === undefined ? undefined : new Decimal(held.minutesHeld);
  // The ATR stop as a value (N221): how far below the entry price, in ATRs at entry.
  if (e.field === 'atrs_below_entry') {
    const atr = held.atrAtEntry?.[e.period ?? DEFAULT_HOLDING_ATR_PERIOD];
    if (!atr || atr.isZero() || !held.checkClose) return undefined;
    const below = held.averagePrice.minus(held.checkClose).div(atr);
    return held.quantity.isNegative() ? below.negated() : below;
  }
  // The expected-move exit as a value (N221): the move since entry, in expected moves at entry.
  if (e.field === 'expected_moves_1d' || e.field === 'expected_moves_5d') {
    const move = held.moveAtEntry?.[e.field === 'expected_moves_1d' ? 1 : 5];
    if (!move || !move.gt(0) || !held.checkClose || held.averagePrice.isZero()) return undefined;
    const n = held.checkClose.minus(held.averagePrice).div(held.averagePrice.times(move));
    return held.quantity.isNegative() ? n.negated() : n;
  }
  const mark = r.value(markExpr(e), barsBack);
  if (!mark) return undefined;
  const move = mark.minus(held.averagePrice);
  if (e.field === 'pnl') return move.times(held.quantity);
  if (held.averagePrice.isZero()) return undefined;
  const pct = move.div(held.averagePrice).times(HUNDRED);
  return held.quantity.isNegative() ? pct.negated() : pct;
}

export type Truth = boolean | undefined;

export function evaluateExpr(expr: Expr, r: SeriesResolver, barsBack = 0): Decimal | undefined {
  switch (expr.kind) {
    case 'constant':
      return new Decimal(expr.value);
    case 'market':
    case 'indicator':
      return r.value(expr, barsBack);
    case 'position':
      return positionValue(expr, r, barsBack);
    case 'metric':
      return computeMetric(
        metricExprRef(expr),
        expr.instrumentId,
        r,
        barsBack + (expr.offset ?? 0),
      );
    case 'stat':
      return statValue(expr, r, barsBack);
    case 'calc': {
      const args: Decimal[] = [];
      for (const arg of expr.args) {
        const v = evaluateExpr(arg, r, barsBack);
        if (v === undefined) return undefined;
        args.push(v);
      }
      const [a = new Decimal(0), b = new Decimal(0)] = args;
      switch (expr.op) {
        case 'add':
          return a.plus(b);
        case 'sub':
          return a.minus(b);
        case 'mul':
          return a.times(b);
        case 'div':
          return b.isZero() ? undefined : a.dividedBy(b);
        case 'neg':
          return a.negated();
        case 'abs':
          return a.abs();
        case 'min':
          return Decimal.min(...args);
        case 'max':
          return Decimal.max(...args);
      }
    }
  }
}

/**
 * A statistical function over its input's own history (v1.2 item 3). The
 * input is evaluated on each of the last `period` bars, so a calculated
 * spread gets the same treatment as a price. Unknown when any of those
 * values is unknown, and the z-score when the deviation is zero.
 */
export function statValue(e: StatExpr, r: SeriesResolver, barsBack = 0): Decimal | undefined {
  const start = barsBack + (e.offset ?? 0);
  const xs: Decimal[] = [];
  for (let k = 0; k < e.period; k++) {
    const v = evaluateExpr(e.input, r, start + k);
    if (v === undefined) return undefined;
    xs.push(v);
  }
  const mean = xs.reduce((a, x) => a.plus(x), new Decimal(0)).div(xs.length);
  switch (e.fn) {
    case 'STDDEV':
      return sampleStdDev(xs);
    case 'ZSCORE': {
      const sd = sampleStdDev(xs);
      const current = xs[0];
      if (!sd || sd.isZero() || !current) return undefined;
      return current.minus(mean).div(sd);
    }
    case 'BB_MIDDLE':
      return mean;
    case 'BB_UPPER':
    case 'BB_LOWER': {
      // Population deviation, exactly as the Bollinger band indicator on a price.
      const sd = populationStdDev(xs);
      if (!sd) return undefined;
      const width = sd.times(new Decimal(e.multiplier ?? '2'));
      return e.fn === 'BB_UPPER' ? mean.plus(width) : mean.minus(width);
    }
    case 'BANDWIDTH': {
      // (upper − lower) / middle, from the same bands; unknown when the middle is 0 (v1.2 item 5).
      const sd = populationStdDev(xs);
      if (!sd || mean.isZero()) return undefined;
      return sd
        .times(new Decimal(e.multiplier ?? '2'))
        .times(2)
        .div(mean);
    }
  }
}

function compare(op: Comparison['operator'], l: Decimal, r: Decimal): boolean {
  switch (op) {
    case 'lt':
      return l.lt(r);
    case 'lte':
      return l.lte(r);
    case 'gt':
      return l.gt(r);
    case 'gte':
      return l.gte(r);
    case 'eq':
      return l.eq(r);
    case 'neq':
      return !l.eq(r);
    default:
      throw new Error(`Not a binary operator: ${op}`);
  }
}

export function evaluateComparison(c: Comparison, r: SeriesResolver): Truth {
  const left = evaluateExpr(c.left, r);
  switch (c.operator) {
    case 'is_available':
      return left !== undefined;
    // A yes/no metric holds when it says yes (N216).
    case 'is_true':
      return left === undefined ? undefined : !left.isZero();
    case 'is_stale': {
      const series = seriesOf(c.left);
      return series ? r.isStale(series) : false;
    }
    case 'between':
    case 'outside': {
      const lower = c.right && evaluateExpr(c.right, r);
      const upper = c.upper && evaluateExpr(c.upper, r);
      if (!left || !lower || !upper) return undefined;
      const inside = left.gte(lower) && left.lte(upper);
      return c.operator === 'between' ? inside : !inside;
    }
    case 'crosses_above':
    case 'crosses_below': {
      if (!c.right) return undefined;
      const right = evaluateExpr(c.right, r);
      const prevLeft = evaluateExpr(c.left, r, 1);
      const prevRight = evaluateExpr(c.right, r, 1);
      if (!left || !right || !prevLeft || !prevRight) return undefined;
      return c.operator === 'crosses_above'
        ? prevLeft.lte(prevRight) && left.gt(right)
        : prevLeft.gte(prevRight) && left.lt(right);
    }
    default: {
      const right = c.right && evaluateExpr(c.right, r);
      if (!left || !right) return undefined;
      return compare(c.operator, left, right);
    }
  }
}

export function evaluateCondition(node: ConditionNode, r: SeriesResolver): Truth {
  if (node.kind === 'comparison') return evaluateComparison(node, r);
  if (node.children.length === 0) return undefined;
  const results = node.children.map((c) => evaluateCondition(c, r));
  let value: Truth;
  if (node.op === 'and') {
    value = results.includes(false) ? false : results.includes(undefined) ? undefined : true;
  } else {
    value = results.includes(true) ? true : results.includes(undefined) ? undefined : false;
  }
  return node.negate && value !== undefined ? !value : value;
}
