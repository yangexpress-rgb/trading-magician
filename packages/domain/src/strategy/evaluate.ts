import Decimal from 'decimal.js';
import type { Comparison, ConditionNode, Expr, IndicatorExpr, MarketExpr } from './schema';

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

export interface SeriesResolver {
  /** Value of a series `barsBack` bars before the expression's own offset, or undefined. */
  value(expr: SeriesExpr, barsBack: number): Decimal | undefined;
  /** Whether the latest value is older than the strategy's stale-data threshold. */
  isStale(expr: SeriesExpr): boolean;
}

export type Truth = boolean | undefined;

export function evaluateExpr(expr: Expr, r: SeriesResolver, barsBack = 0): Decimal | undefined {
  switch (expr.kind) {
    case 'constant':
      return new Decimal(expr.value);
    case 'market':
    case 'indicator':
      return r.value(expr, barsBack);
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
    case 'is_stale':
      return c.left.kind === 'market' || c.left.kind === 'indicator' ? r.isStale(c.left) : false;
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
