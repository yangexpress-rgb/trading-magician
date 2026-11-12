import type {
  BacktestOrder,
  ConditionCheck,
  ConditionOutcome,
  OrderOutcome,
  PhaseConditionReport,
  StoredTruth,
} from '@tm/backtest';
import type { BarInterval, Comparison, ConditionNode, Expr } from '@tm/domain';
import type { Tone } from '@tm/ui';
import { formatDay, formatMarketTime, formatMoney } from './backtest-text';
import {
  describeExpr,
  OPERATOR_SYMBOLS,
  ORDER_TYPE_LABELS,
  SIDE_LABELS,
  TIF_LABELS,
  TRIGGER_LABELS,
  type SymbolLookup,
} from './strategy-text';

/**
 * Words for the back-test condition and order reports: which data each
 * condition saw, whether it held, and why each planned order did or didn't fill.
 */

export const TRUTH: Record<'true' | 'false' | 'null', { label: string; tone: Tone }> = {
  true: { label: 'True', tone: 'ok' },
  false: { label: 'False', tone: 'neutral' },
  null: { label: 'No data', tone: 'warn' },
};
export const truthOf = (t: StoredTruth) => TRUTH[String(t) as keyof typeof TRUTH];

export const CONDITION_OUTCOMES: Record<ConditionOutcome, string> = {
  fired: 'Fired: orders planned',
  confirming: 'True, waiting for the confirmation bars',
  cooldown: 'True, but inside the cooldown after the last firing',
  already_true: 'True, but it was already true: the trigger fires only when it becomes true',
  fired_before: 'True, but the trigger fires once per cycle and already did',
  cycle_open: 'Fired, but a cycle was already open, so no new orders',
  daily_loss: 'Fired, but new entries were stopped by the daily loss limit',
  drawdown: 'Fired, but new entries were stopped by the maximum drawdown',
};

export const ORDER_OUTCOMES: Record<OrderOutcome, { label: string; tone: Tone }> = {
  filled: { label: 'Filled', tone: 'ok' },
  partial: { label: 'Partly filled', tone: 'warn' },
  canceled: { label: 'Canceled', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  working_at_end: { label: 'Pending at end of test', tone: 'info' },
  not_sent: { label: 'Not sent', tone: 'neutral' },
};

/** A stored value as written in the tables: 2 decimals, or 4 below 1, grouped. */
export function formatValue(v: string | null | undefined): string {
  if (v === null || v === undefined) return 'no data';
  const n = Number(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 1 ? 2 : 4 });
}

/** The comparisons of a tree, in the order they appear. */
export function comparisonsOf(node: ConditionNode): Comparison[] {
  return node.kind === 'comparison' ? [node] : node.children.flatMap(comparisonsOf);
}

/** The common exits a Position value stands for in Exit when (N217, N221). */
const HOLDING_EXITS: Partial<Record<string, string>> = {
  off_peak_pct: 'trailing stop',
  days_held: 'holding period',
  atrs_below_entry: 'ATR stop',
  expected_moves_1d: 'expected move',
  expected_moves_5d: 'expected move',
};

/**
 * Which common exits held on the bar Exit when fired, e.g. ["trailing stop"],
 * so the cycle card can say which part of Exit when sold (N223). Empty when
 * only other conditions held.
 */
export function heldExits(
  node: ConditionNode,
  checks: readonly ConditionCheck[] | undefined,
): string[] {
  const truth = new Map((checks ?? []).map((c) => [c.id, c.truth]));
  const out: string[] = [];
  for (const c of comparisonsOf(node)) {
    const name = c.left.kind === 'position' ? HOLDING_EXITS[c.left.field] : undefined;
    if (name && truth.get(c.id) === true && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The data a comparison saw on one bar, e.g. "101.2 vs 100" or "101 (was 99) vs 100 (was 100)". */
export function describeValues(c: Comparison, check: ConditionCheck | undefined): string {
  if (!check) return '—';
  const values = comparedValues(c, check);
  // Options metrics read an end-of-day signal: say which day's (options brief v2 §5.3).
  const notes = [
    ...(check.optionsAsOf?.length ? [`options as of ${check.optionsAsOf.join(', ')}`] : []),
    // Earnings, deal and rate metrics name the record they read (ADR 0058).
    ...(check.eventsAsOf?.length ? [`from ${check.eventsAsOf.join(', ')}`] : []),
    // Model scores name the run and dates behind them (ML brief v1 §10).
    ...(check.mlAsOf ?? []),
  ];
  return notes.length > 0 ? `${values} (${notes.join('; ')})` : values;
}

function comparedValues(c: Comparison, check: ConditionCheck): string {
  const v = formatValue;
  switch (c.operator) {
    case 'is_available':
      return check.left === null ? 'no data' : v(check.left);
    case 'is_true':
      return check.left == null ? 'no data' : Number(check.left) === 0 ? 'no' : 'yes';
    case 'is_stale':
      return check.truth ? 'stale' : 'up to date';
    case 'between':
    case 'outside':
      return `${v(check.left)} vs ${v(check.right)} to ${v(check.upper)}`;
    case 'crosses_above':
    case 'crosses_below':
      return `${v(check.left)} (was ${v(check.prevLeft)}) vs ${v(check.right)} (was ${v(check.prevRight)})`;
    default:
      return `${v(check.left)} vs ${v(check.right)}`;
  }
}

/** One data element a comparison read, e.g. "this instrument close" = "105.2". */
export interface DataElement {
  label: string;
  value: string;
  /** A value inside a calculation, shown under the side it was used in. */
  inside?: boolean;
  /** Which bar it came from, when not the bar checked, e.g. "Oct 13, 2026 close" (N224). */
  at?: string;
}

/** What a comparison read and why it came out as it did (N218). */
export interface ComparisonEvidence {
  /** Each side that isn't a plain number, and each value inside a calculation. */
  elements: DataElement[];
  /** The comparison with its values, e.g. "105.2 ≥ 103", or "12 > 1" when it asked for ≤ 1. */
  reason: string | null;
  /** The records read: options signal dates, earnings and deal records. */
  sources: string[];
}

const NEGATED: Partial<Record<Comparison['operator'], string>> = {
  lt: '≥',
  lte: '>',
  gt: '≤',
  gte: '<',
  eq: '≠',
  neq: '=',
};

/** The data elements and values behind one comparison on one evaluation (N218). */
export function comparisonEvidence(
  c: Comparison,
  check: ConditionCheck | undefined,
  symbol: SymbolLookup,
): ComparisonEvidence {
  const v = formatValue;
  if (!check) return { elements: [], reason: null, sources: [] };
  const elements: DataElement[] = [];
  // Which bar a price, indicator or close came from (N224).
  const barText = (iso: string | null | undefined, interval: BarInterval) =>
    iso
      ? interval === '1d' || interval === '1w'
        ? `${formatMarketTime(iso, '1d')} close`
        : `bar ending ${formatMarketTime(iso, '1h')}`
      : undefined;
  const atOf = (x: Expr) =>
    x.kind === 'market' || x.kind === 'indicator'
      ? barText(check.inputs?.[`${x.id}:at`], x.interval)
      : undefined;
  const element = (label: string, value: string, extra: Partial<DataElement> = {}) => {
    const at = extra.at;
    elements.push({ label, value, ...extra, ...(at ? { at } : {}) });
  };
  const side = (e: Expr | undefined, value: string | null | undefined, prev?: string | null) => {
    if (!e || e.kind === 'constant') return;
    const at = atOf(e);
    element(
      describeExpr(e, symbol),
      prev !== undefined ? `${v(value)} (was ${v(prev)})` : v(value),
      at ? { at } : {},
    );
    // The values a calculation was worked out from (N218).
    const inner = (x: Expr) => {
      if (x.kind === 'calc') x.args.forEach(inner);
      else if (x.kind !== 'constant' && check.inputs && x.id in check.inputs) {
        const at = atOf(x);
        element(describeExpr(x, symbol), v(check.inputs[x.id]), {
          inside: true,
          ...(at ? { at } : {}),
        });
      }
    };
    if (e.kind === 'calc') e.args.forEach(inner);
    positionInputs(e);
  };
  // What a position value was worked out from (ADR 0074).
  const positionInputs = (e: Expr) => {
    if (e.kind === 'calc') e.args.forEach(positionInputs);
    if (e.kind !== 'position' || !check.inputs) return;
    const input = (key: string) => check.inputs?.[`${e.id}:${key}`];
    const add = (key: string, label: string, at?: string) => {
      const value = input(key);
      if (value !== undefined) element(label, v(value), { inside: true, ...(at ? { at } : {}) });
    };
    const opened = input('opened');
    if (opened) element('Entry filled', formatMarketTime(opened, '1h'), { inside: true });
    if (e.field === 'days_held') {
      add('days', 'Trading days held, counting the entry day');
      return;
    }
    add('entry', 'Entry price');
    add('peak', e.field === 'off_peak_pct' ? 'Best close since entry' : 'Best close');
    add('atr', 'ATR at entry');
    // The expected move is stored as a fraction.
    const move = input('move');
    if (move !== undefined)
      element(
        'Expected move at entry',
        move === null ? v(move) : `${formatValue(String(Number(move) * 100))}%`,
        { inside: true },
      );
    add('mark', 'Latest close', barText(input('markAt'), e.interval));
    add('close', 'Close checked', barText(input('closeAt'), '1h'));
  };
  const crosses = c.operator === 'crosses_above' || c.operator === 'crosses_below';
  if (c.operator !== 'is_stale') side(c.left, check.left, crosses ? check.prevLeft : undefined);
  side(c.right, check.right, crosses ? check.prevRight : undefined);
  side(c.upper, check.upper);
  const sources = [
    ...(check.optionsAsOf?.length ? [`Options signal as of ${check.optionsAsOf.join(', ')}`] : []),
    // Earnings, deal and rate records, with their dates written out (N224).
    ...(check.eventsAsOf ?? []).map((x) => x.replace(/\d{4}-\d{2}-\d{2}/g, (d) => formatDay(d))),
    // Model scores: the model, its run, its training end and the score's date (ML brief v1 §10).
    ...(check.mlAsOf ?? []),
  ];
  return { elements, reason: reasonOf(c, check), sources };
}

function reasonOf(c: Comparison, check: ConditionCheck): string | null {
  const v = formatValue;
  const op = OPERATOR_SYMBOLS[c.operator];
  if (check.truth === null) {
    const missing = [check.left, check.right, check.upper].some((x) => x === null);
    return missing ? 'Not decided: a value had no data on this bar' : 'Not decided';
  }
  switch (c.operator) {
    case 'is_available':
      return check.truth ? 'The value was available' : 'The value had no data';
    case 'is_stale':
      return check.truth ? 'The data was stale' : 'The data was up to date';
    case 'is_true':
      return check.truth ? 'It held (yes)' : 'It did not hold (no)';
    case 'between':
    case 'outside':
      return `${v(check.left)} is ${
        (c.operator === 'between') === check.truth ? 'between' : 'outside'
      } ${v(check.right)} and ${v(check.upper)}`;
    case 'crosses_above':
    case 'crosses_below':
      return check.truth
        ? `Crossed: ${v(check.prevLeft)} → ${v(check.left)} against ${v(check.prevRight)} → ${v(check.right)}`
        : `Did not cross: ${v(check.prevLeft)} → ${v(check.left)} against ${v(check.prevRight)} → ${v(check.right)}`;
    default:
      return check.truth
        ? `${v(check.left)} ${op} ${v(check.right)}`
        : `${v(check.left)} ${NEGATED[c.operator] ?? `not ${op}`} ${v(check.right)}`;
  }
}

export function describeTrigger(trigger: PhaseConditionReport['trigger']): string {
  // A slot's Exit has no trigger: it exits on any bar its condition is true (ADR 0049).
  if (!trigger) return 'Fires on every bar the condition is true';
  const parts = [`Fires ${TRIGGER_LABELS[trigger.mode].replace(' (default)', '').toLowerCase()}`];
  if (trigger.confirmationBars > 0)
    parts.push(
      `after ${trigger.confirmationBars} confirmation ${trigger.confirmationBars === 1 ? 'bar' : 'bars'}`,
    );
  // Runs from before schema 2 recorded the cooldown in seconds.
  const old = (trigger as { cooldownSec?: number }).cooldownSec;
  if (trigger.cooldownBars > 0)
    parts.push(`${trigger.cooldownBars} ${trigger.cooldownBars === 1 ? 'bar' : 'bars'} cooldown`);
  else if (old !== undefined && old > 0) parts.push(`${old}s cooldown`);
  return parts.join(' · ');
}

const times = (n: number) => (n === 1 ? 'once' : `${n} times`);
const bars = (n: number) => `${n} ${n === 1 ? 'bar' : 'bars'}`;

/** One sentence on how a phase's conditions went. */
export function summarizeConditions(phase: 'entry' | 'exit', r: PhaseConditionReport): string {
  const name = phase === 'entry' ? 'Entry' : 'Exit';
  if (r.evaluated === 0) {
    return phase === 'entry'
      ? 'The Entry conditions were never checked: there were no bars in the dates.'
      : 'The Exit conditions were never checked, because no Entry filled to open a position.';
  }
  const where = phase === 'exit' ? ' while a position was open' : '';
  const data = r.unknownBars > 0 ? `, no data on ${r.unknownBars}` : '';
  return `${name} conditions were checked on ${bars(r.evaluated)}${where}: true on ${r.trueBars}, false on ${r.falseBars}${data}. They fired ${r.fired === 0 ? 'never' : times(r.fired)}.`;
}

/** "Buy 10 NKE · Market · Day", with the computed limit and stop when it had them. */
export function describeOrder(o: BacktestOrder): string {
  const qty = o.quantity ?? '';
  let type: string = ORDER_TYPE_LABELS[o.orderType];
  if (o.limitPrice) type += ` at ${formatMoney(o.limitPrice)}`;
  if (o.stopPrice) type += `, stop ${formatMoney(o.stopPrice)}`;
  return [
    `${SIDE_LABELS[o.side]} ${qty ? `${qty} ` : ''}${o.symbol}`,
    type,
    TIF_LABELS[o.timeInForce],
  ].join(' · ');
}

const money = (v: string | undefined) => (v === undefined ? '?' : formatMoney(v));
const pct = (v: string | undefined) => `${v ?? '?'}%`;

/** Why an order ended the way it did, in a sentence with its figures. */
export function explainOrder(o: BacktestOrder): string {
  const d = o.detail;
  const filled =
    Number(o.filledQuantity) > 0
      ? `Filled ${o.filledQuantity}${o.quantity && o.outcome !== 'filled' ? ` of ${o.quantity}` : ''} at ${money(o.averagePrice ?? undefined)}${o.fills > 1 ? ' average' : ''}`
      : '';
  const reason = (() => {
    switch (o.reason) {
      case null:
        return '';
      case 'collar_cancel':
        return `The next open was ${money(d.price)}, ${pct(d.movePct)} from the last close of ${money(d.reference)}. The price collar allows ${pct(d.limitPct)}.`;
      case 'risk_collar':
        return `The limit price was ${pct(d.value)} from the last close. The price collar allows ${pct(d.limit)}.`;
      case 'risk_order_size':
        return `The order was worth ${money(d.value)}, above the maximum order size of ${money(d.limit)}.`;
      case 'risk_exposure':
        return `Exposure would have reached ${money(d.value)}, above the maximum strategy exposure of ${money(d.limit)}.`;
      case 'buying_power':
        return `Exposure would have reached ${money(d.value)}, more than the ${money(d.limit)} of equity (no leverage).`;
      case 'risk_active_orders':
        return `${d.value ?? '?'} orders were already working, and the maximum is ${d.limit ?? '?'}.`;
      case 'risk_open_positions':
        return `${d.value ?? '?'} positions were already open, and the maximum is ${d.limit ?? '?'}.`;
      case 'risk_daily_loss':
        return 'New entries were stopped for the day after the daily loss limit was hit.';
      case 'risk_drawdown':
        return 'New entries were stopped after the maximum drawdown was hit.';
      case 'stale_data':
        return 'The price was stale.';
      case 'market_closed':
        return 'The market was closed, and the strategy cancels orders outside regular hours.';
      case 'no_price':
        return 'There was no price for the instrument yet.';
      case 'price_unavailable':
        return 'Its limit or stop price could not be computed for lack of data.';
      case 'no_stop_distance':
        return 'It is risk-sized, and the stop was at the current price, so no size could be worked out.';
      case 'nothing_to_close':
        return 'There was no position left to close.';
      case 'zero_quantity':
        return 'Its quantity rounded down to zero shares.';
      case 'day_expired':
        return 'It was a day order and expired at the close.';
      case 'leg_timeout':
        return `It did not fill within the ${d.timeoutSec ?? '?'}-second leg timeout.`;
      case 'other_leg_failed':
        return `Canceled because leg “${d.leg ?? '?'}” did not fill.`;
      case 'fok_canceled':
        return 'Fill or kill: the bar could not fill all of it under the volume cap.';
      case 'ioc_canceled':
        return 'Immediate or cancel: what did not fill on the first bar was canceled.';
      case 'no_bar_after':
        return 'It was placed at the last close, so the test ended before a bar it could fill on. A later end date would show it fill.';
      case 'limit_not_reached':
        return `The price never reached the ${money(o.limitPrice ?? undefined)} limit${
          o.bestPrice ? `: the best was ${money(o.bestPrice)} over ${bars(o.barsWorking)}` : ''
        }.`;
      case 'stop_not_reached':
        return `The price never reached the ${money(o.stopPrice ?? undefined)} stop over ${bars(o.barsWorking)}.`;
      case 'volume_cap':
        return 'It was still filling a share of each bar under the volume cap when the test ended.';
      case 'exit_not_triggered':
        return 'The Exit conditions had not fired by the end of the test, so the position was still open.';
      case 'entry_not_triggered':
        return 'The Entry conditions had not fired.';
      case 'waiting_for_prior_leg':
        return 'It was waiting for the previous leg to fill.';
      case 'timing_not_due':
        return 'Its timing had not come due by the end of the test.';
      case 'not_needed':
        return 'Not needed: the cycle ended before this leg was due.';
      default:
        return o.reason;
    }
  })();
  return [filled && `${filled}.`, reason].filter(Boolean).join(' ') || '—';
}
