import {
  CONTEXT_INSTRUMENT_ID,
  getIndicator,
  getMetric,
  isImmediateTrigger,
  type ComparisonOperator,
  type ConditionNode,
  type Expr,
  type PlannedOrder,
  type RiskProfile,
  type StrategyDefinition,
  type TRIGGER_MODES,
  type Trigger,
  UNARY_OPERATORS,
} from './index';

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
  is_true: 'Not needed',
};

export const OPERATOR_SYMBOLS: Record<ComparisonOperator, string> = {
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
  is_true: 'holds',
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

export const POSITION_FIELD_LABELS = {
  entry_price: 'Entry price',
  gain_pct: 'Gain %',
  pnl: 'Profit or loss',
  quantity: 'Quantity held',
  off_peak_pct: 'Off best close since entry %',
  days_held: 'Trading days held',
  atrs_below_entry: 'Below entry, in ATRs at entry',
  expected_moves_1d: 'Move since entry, in 1-day expected moves',
  expected_moves_5d: 'Move since entry, in 5-day expected moves',
  minutes_held: 'Minutes held',
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

function instrumentText(id: string, symbol: SymbolLookup): string {
  return id === CONTEXT_INSTRUMENT_ID ? 'this instrument' : (symbol(id) ?? '?');
}

/** Compact text for an expression, e.g. "SMA(30) of DEMO-A close". */
export function describeExpr(expr: Expr, symbol: SymbolLookup): string {
  switch (expr.kind) {
    case 'constant':
      return expr.value;
    case 'market': {
      const ago = expr.offset ? ` ${expr.offset} ${expr.offset === 1 ? 'bar' : 'bars'} ago` : '';
      return `${instrumentText(expr.instrumentId, symbol)} ${FIELD_LABELS[expr.field].toLowerCase()}${ago}`;
    }
    case 'indicator': {
      const spec = getIndicator(expr.name);
      const params = spec
        ? spec.params.map((p) => expr.params[p.name] ?? p.default).join(', ')
        : '';
      const field = spec?.defaultField === null ? '' : ` ${FIELD_LABELS[expr.field].toLowerCase()}`;
      // Highest/Lowest show their window's offset as a parameter (v1.2 item 7).
      if (spec?.builderOffset !== undefined)
        return `${expr.name}(${params}, offset ${expr.offset}) of ${instrumentText(expr.instrumentId, symbol)}${field}`;
      const ago = expr.offset ? ` ${expr.offset} ${expr.offset === 1 ? 'bar' : 'bars'} ago` : '';
      return `${expr.name}(${params}) of ${instrumentText(expr.instrumentId, symbol)}${field}${ago}`;
    }
    case 'metric': {
      const spec = getMetric(expr.metric);
      const params = spec
        ? spec.params
            .map((p) => {
              const v = expr.params[p.name] ?? p.default;
              return p.kind === 'instrument' ? (symbol(String(v)) ?? '?') : String(v);
            })
            .join(', ')
        : '';
      // Metrics without parameters (fundamental and options ones) read without "()".
      return `${spec?.label ?? expr.metric}${params ? `(${params})` : ''} of ${instrumentText(expr.instrumentId, symbol)}`;
    }
    case 'stat': {
      const mult =
        expr.multiplier && (expr.fn.startsWith('BB_') || expr.fn === 'BANDWIDTH')
          ? `, ${expr.multiplier}`
          : '';
      const ago = expr.offset ? ` ${expr.offset} ${expr.offset === 1 ? 'bar' : 'bars'} ago` : '';
      return `${expr.fn}(${describeExpr(expr.input, symbol)}, ${expr.period}${mult})${ago}`;
    }
    case 'position':
      return `${instrumentText(expr.instrumentId, symbol)} position ${POSITION_FIELD_LABELS[expr.field].toLowerCase()}`;
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
    if (UNARY_OPERATORS.includes(node.operator)) return `${left} ${op}`;
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

export const SIDE_LABELS = {
  buy: 'Buy',
  sell: 'Sell',
  sell_short: 'Sell short',
  buy_to_cover: 'Buy to cover',
  close: 'Close position',
  reduce: 'Reduce position',
} as const;

export const QUANTITY_LABELS = {
  units: 'Units (shares)',
  notional: 'Amount (base currency)',
  pct_equity: '% of account equity',
  risk: 'Risk (lose at most this at the stop)',
} as const;

export const ORDER_TYPE_LABELS = {
  market: 'Market',
  limit: 'Limit',
  stop: 'Stop',
  stop_limit: 'Stop-limit',
} as const;

export const TIF_LABELS = {
  day: 'Day',
  gtc: 'Good till cancelled',
  ioc: 'Immediate or cancel',
  fok: 'Fill or kill',
} as const;

export const UNIT_LABELS = { s: 'seconds', min: 'minutes', h: 'hours', d: 'days' } as const;

export const PHASE_EVENT_LABELS = {
  entry_trigger: 'Entry trigger time',
  entry_submitted: 'Entry order submitted',
  entry_partial_fill: 'Entry order partially filled',
  entry_full_fill: 'Entry order fully filled',
  position_opened: 'Position opened',
} as const;

export const LEG_EVENT_LABELS = { submitted: 'submitted', filled: 'filled' } as const;

/** When a planned order becomes eligible, e.g. "5 minutes after entry order submitted". */
export function describeTiming(
  order: PlannedOrder,
  labelOf: (legId: string) => string | undefined,
  /** "Allow timed entries without conditions" (ADR 0049). */
  timingOnly = false,
): string {
  const t = order.timing;
  if (t.mode === 'immediate') return 'Immediately when the conditions qualify';
  const suffix = timingOnly ? ' (timing only)' : '';
  if (t.mode === 'exact') return `At ${t.at || '…'} (${t.zone})${suffix}`;
  const ref =
    t.reference.kind === 'phase'
      ? PHASE_EVENT_LABELS[t.reference.event].toLowerCase()
      : `“${labelOf(t.reference.legId) ?? 'removed leg'}” ${t.reference.event}`;
  return `${t.amount} ${UNIT_LABELS[t.unit]} after ${ref}${suffix}`;
}

const QUANTITY_UNITS = {
  units: (v: string) => v,
  notional: (v: string, ccy: string) => `${ccy} ${v} of`,
  pct_equity: (v: string) => `${v}% of equity in`,
  risk: (v: string, ccy: string, q?: PlannedOrder['quantity']) =>
    q?.amountIn === 'dollars' ? `${ccy} ${v} at risk in` : `${v}% of equity at risk in`,
} as const;

/** One-line text for a leg, e.g. "Buy 100 DEMO-A · Limit at 99.5 · Day". */
export function describeLeg(
  order: PlannedOrder,
  symbol: SymbolLookup,
  currency: string,
  /** The Entry's risk distance, for a leg sized from the ATR (ADR 0049). */
  risk?: { atrPeriod: number; atrMultiple: string } | undefined,
): string {
  const q = order.quantity;
  const qty = QUANTITY_UNITS[q.type](q.value, currency, q);
  const parts = [`${SIDE_LABELS[order.side]} ${qty} ${instrumentText(order.instrumentId, symbol)}`];
  // v1.2 item 9: the sizing stop, e.g. "sized for a stop 2 × ATR(20) away".
  if (q.type === 'risk' && q.distanceFrom === 'atr') {
    parts[0] += `, sized for a stop ${risk?.atrMultiple ?? '…'} × ATR(${risk?.atrPeriod ?? '…'}) away`;
  }
  let type: string = ORDER_TYPE_LABELS[order.orderType];
  if (order.limitPrice) type += ` at ${describeExpr(order.limitPrice, symbol)}`;
  if (order.stopPrice) type += `, stop ${describeExpr(order.stopPrice, symbol)}`;
  parts.push(type, TIF_LABELS[order.timeInForce]);
  return parts.join(' · ');
}

const PHASE_NAMES = { entry: 'Entry', exit: 'Exit' } as const;
const SECTION_NAMES: Record<string, string> = {
  condition: 'conditions',
  trigger: 'trigger options',
  orders: 'orders',
  selection: 'Selection group',
  fireMode: 'leg choice',
  rules: 'rules',
};

/**
 * Where a validation issue lives, in the words the editor uses, e.g.
 * "Entry leg 2 (Short B)" or "Risk limits".
 */
export function describeIssueLocation(
  path: readonly (string | number)[],
  def: StrategyDefinition,
): string {
  const [head, section, index] = path;
  // An entry group's problem (v1.2 item 8): "Short breakdown: Entry leg 1 (Short SPY)".
  if (head === 'groups' && typeof section === 'number') {
    const group = def.groups?.[section];
    if (!group) return 'Entry groups';
    const rest = path.slice(2);
    if (rest.length === 0 || rest[0] === 'label') return `Entry group "${group.label}"`;
    const inner = { ...def, entry: group.entry, exit: group.exit, groups: undefined };
    return `${group.label}: ${describeIssueLocation(rest, inner)}`;
  }
  if (head === 'groups') return 'Entry groups';
  if (head === 'entry' || head === 'exit') {
    const phase = PHASE_NAMES[head];
    if (section === 'orders' && typeof index === 'number') {
      const label = def[head].orders[index]?.legLabel;
      return `${phase} leg ${index + 1}${label ? ` (${label})` : ''}`;
    }
    const name = typeof section === 'string' ? SECTION_NAMES[section] : undefined;
    return name ? `${phase} ${name}` : phase;
  }
  if (head === 'execution') return 'Order handling';
  if (head === 'schedule') return 'Schedule';
  if (head === 'risk') return 'Risk limits';
  return 'Strategy';
}

/** Re-exported for pages that read trigger text from strategy-text (N273). */
export { isImmediateTrigger };

export const TRIGGER_LABELS: Record<(typeof TRIGGER_MODES)[number], string> = {
  on_transition: 'When it becomes true',
  while_true: 'Repeatedly while true, after the cooldown',
  once_per_cycle: 'Once per strategy cycle',
};

/** "Fire when" in words (ADR 0049); no trigger means a slot's Exit, checked directly. */
export function describeTrigger(t: Trigger | undefined): string {
  if (!t) return 'On every bar the condition is true';
  if (isImmediateTrigger(t)) return 'Immediately, on every check it is true';
  const n = t.confirmationBars + 1;
  const when =
    t.mode === 'on_transition'
      ? t.confirmationBars > 0
        ? `After it has been true for ${n} bars`
        : 'As soon as it becomes true'
      : t.mode === 'while_true'
        ? `Repeatedly while true${t.confirmationBars > 0 ? `, after ${n} bars true` : ''}`
        : `Once per cycle${t.confirmationBars > 0 ? `, after ${n} bars true` : ''}`;
  return t.cooldownBars > 0
    ? `${when}; then waits ${t.cooldownBars} ${t.cooldownBars === 1 ? 'bar' : 'bars'}`
    : when;
}

export const RISK_FIELDS: {
  key: keyof RiskProfile;
  label: string;
  unit: 'money' | 'pct' | 'count';
}[] = [
  { key: 'maxOrderNotional', label: 'Maximum order size', unit: 'money' },
  { key: 'maxStrategyExposure', label: 'Maximum strategy exposure', unit: 'money' },
  { key: 'maxActiveOrders', label: 'Maximum active orders', unit: 'count' },
  { key: 'dailyLossLimit', label: 'Daily loss limit', unit: 'money' },
  { key: 'priceCollarPct', label: 'Price collar', unit: 'pct' },
  { key: 'maxInstrumentsHeld', label: 'Maximum instruments held', unit: 'count' },
  { key: 'maxDrawdownPct', label: 'Maximum drawdown', unit: 'pct' },
];

export const MULTI_LEG_LABELS = {
  concurrent: 'All at once',
  sequential: 'One after another, in order',
  after_prior_fill: 'Next leg only after the previous one fills',
} as const;

export const LEG_FAILURE_LABELS = {
  cancel_remaining: 'Cancel the remaining legs',
  flatten_filled: 'Cancel the rest and close filled legs',
  leave_and_alert: 'Leave orders as they are and alert me',
} as const;

export const MARKET_HOURS_LABELS = {
  queue: 'Queue until the next regular session',
  cancel: 'Cancel the order',
  extended_if_supported: 'Send in extended hours if allowed',
} as const;
