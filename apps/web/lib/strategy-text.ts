import { getIndicator, type ComparisonOperator, type ConditionNode, type Expr } from '@tm/domain';

/** Human labels for the strategy vocabulary, shared by the editor and summaries. */

export const OPERATOR_LABELS: Record<ComparisonOperator, string> = {
  lt: 'is less than (<)',
  lte: 'is at most (≤)',
  gt: 'is greater than (>)',
  gte: 'is at least (≥)',
  eq: 'equals (=)',
  neq: 'does not equal (≠)',
  crosses_above: 'crosses above',
  crosses_below: 'crosses below',
  between: 'is between',
  outside: 'is outside',
  is_available: 'is available',
  is_stale: 'is stale',
};

const OPERATOR_SYMBOLS: Record<ComparisonOperator, string> = {
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  eq: '=',
  neq: '≠',
  crosses_above: 'crosses above',
  crosses_below: 'crosses below',
  between: 'between',
  outside: 'outside',
  is_available: 'is available',
  is_stale: 'is stale',
};

export const FIELD_LABELS = {
  last: 'Last',
  bid: 'Bid',
  ask: 'Ask',
  mid: 'Midpoint',
  open: 'Open',
  high: 'High',
  low: 'Low',
  close: 'Close',
  volume: 'Volume',
  vwap: 'VWAP',
} as const;

export const INTERVAL_LABELS = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '15m': '15 minutes',
  '30m': '30 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  '1d': '1 day',
  '1w': '1 week',
} as const;

export const ADJUSTMENT_LABELS = {
  split_and_dividend: 'Splits and dividends',
  split_only: 'Splits only',
  none: 'None',
} as const;

export const CALC_LABELS = {
  add: 'Add (+)',
  sub: 'Subtract (−)',
  mul: 'Multiply (×)',
  div: 'Divide (÷)',
  neg: 'Negate (−x)',
  abs: 'Absolute value',
  min: 'Smallest of',
  max: 'Largest of',
} as const;

const CALC_SYMBOLS = { add: '+', sub: '−', mul: '×', div: '÷' } as const;

export type SymbolLookup = (instrumentId: string) => string | undefined;

/** Compact text for an expression, e.g. "SMA(30) of DEMO-A close". */
export function describeExpr(expr: Expr, symbol: SymbolLookup): string {
  switch (expr.kind) {
    case 'constant':
      return expr.value;
    case 'market': {
      const ago = expr.offset ? ` ${expr.offset} bars ago` : '';
      return `${symbol(expr.instrumentId) ?? '?'} ${FIELD_LABELS[expr.field].toLowerCase()}${ago}`;
    }
    case 'indicator': {
      const spec = getIndicator(expr.name);
      const params = spec
        ? spec.params.map((p) => expr.params[p.name] ?? p.default).join(', ')
        : '';
      const field = spec?.defaultField === null ? '' : ` ${FIELD_LABELS[expr.field].toLowerCase()}`;
      const ago = expr.offset ? ` ${expr.offset} bars ago` : '';
      return `${expr.name}(${params}) of ${symbol(expr.instrumentId) ?? '?'}${field}${ago}`;
    }
    case 'calc': {
      const args = expr.args.map((a) => describeExpr(a, symbol));
      if (expr.op === 'neg') return `−(${args[0] ?? ''})`;
      if (expr.op === 'abs') return `|${args[0] ?? ''}|`;
      if (expr.op === 'min' || expr.op === 'max') return `${expr.op}(${args.join(', ')})`;
      return `(${args.join(` ${CALC_SYMBOLS[expr.op]} `)})`;
    }
  }
}

/** One-line text for a condition tree, with explicit parentheses for groups. */
export function describeCondition(node: ConditionNode, symbol: SymbolLookup): string {
  if (node.kind === 'comparison') {
    const left = describeExpr(node.left, symbol);
    const op = OPERATOR_SYMBOLS[node.operator];
    if (node.operator === 'is_available' || node.operator === 'is_stale') return `${left} ${op}`;
    const right = node.right ? describeExpr(node.right, symbol) : '?';
    if (node.operator === 'between' || node.operator === 'outside') {
      const upper = node.upper ? describeExpr(node.upper, symbol) : '?';
      return `${left} ${op} ${right} and ${upper}`;
    }
    return `${left} ${op} ${right}`;
  }
  const inner = node.children
    .map((c) => {
      const text = describeCondition(c, symbol);
      return c.kind === 'group' && !c.negate ? `(${text})` : text;
    })
    .join(node.op === 'and' ? ' AND ' : ' OR ');
  return node.negate ? `NOT (${inner || 'empty'})` : inner || 'empty';
}
