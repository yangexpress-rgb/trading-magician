import Decimal from 'decimal.js';
import type {
  Comparison,
  ConditionNode,
  Expr,
  IndicatorExpr,
  MarketExpr,
  PositionExpr,
} from './schema';

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

/** A resolver that also answers for one cycle's positions. */
export function withPositions(
  r: SeriesResolver,
  position: (instrumentId: string) => PositionSnapshot | undefined,
): SeriesResolver {
  return {
    value: (expr, barsBack) => r.value(expr, barsBack),
    isStale: (expr) => r.isStale(expr),
    position,
  };
}

const HUNDRED = new Decimal(100);

function positionValue(e: PositionExpr, r: SeriesResolver, barsBack: number): Decimal | undefined {
  const p = r.position?.(e.instrumentId);
  const held = p && !p.quantity.isZero() ? p : undefined;
  if (e.field === 'quantity') return held ? held.quantity : new Decimal(0);
  if (!held) return undefined;
  if (e.field === 'entry_price') return held.averagePrice;
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
