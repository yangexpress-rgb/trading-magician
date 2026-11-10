import {
  DEFAULT_HOLDING_ATR_PERIOD,
  evaluateComparison,
  evaluateCondition,
  evaluateExpr,
  isEventMetricId,
  markExpr,
  optionMetricField,
  type ConditionNode,
  type Expr,
  inCooldown,
  type SeriesResolver,
  type Trigger,
  type TriggerState,
  type Truth,
} from '@tm/domain';
import type Decimal from 'decimal.js';
import type {
  ComparisonSummary,
  ConditionBar,
  ConditionCheck,
  ConditionOutcome,
  PhaseConditionReport,
  StoredTruth,
} from './results';

/**
 * Records how a phase's conditions evaluated on each bar, so the results can
 * show which data was found and which conditions held (Design v1.0 §7.3). It
 * re-evaluates with the shared evaluator rather than duplicating its logic.
 */

/** Bars kept per phase before the log keeps only the bars that matter. */
export const MAX_CONDITION_BARS = 2500;

const num = (d: Decimal | undefined): string | null =>
  d === undefined ? null : d.toDecimalPlaces(4).toString();
const stored = (t: Truth): StoredTruth => (t === undefined ? null : t);

function checksFor(
  node: ConditionNode,
  r: SeriesResolver,
  out: ConditionCheck[],
  /** The evaluation's time: a bar that ended then needs no time of its own. */
  now?: string,
): Truth {
  if (node.kind === 'group') {
    for (const child of node.children) checksFor(child, r, out, now);
    const truth = evaluateCondition(node, r);
    out.push({ id: node.id, truth: stored(truth) });
    return truth;
  }
  const truth = evaluateComparison(node, r);
  const check: ConditionCheck = { id: node.id, truth: stored(truth) };
  if (node.operator !== 'is_stale') check.left = num(evaluateExpr(node.left, r));
  if (node.right) check.right = num(evaluateExpr(node.right, r));
  if (node.upper) check.upper = num(evaluateExpr(node.upper, r));
  if (node.operator === 'crosses_above' || node.operator === 'crosses_below') {
    check.prevLeft = num(evaluateExpr(node.left, r, 1));
    check.prevRight = node.right ? num(evaluateExpr(node.right, r, 1)) : null;
  }
  const asOf = optionDates([node.left, node.right, node.upper], r);
  if (asOf.length > 0) check.optionsAsOf = asOf;
  const events = eventDates([node.left, node.right, node.upper], r);
  if (events.length > 0) check.eventsAsOf = events;
  const inputs = calcInputs([node.left, node.right, node.upper], r, now);
  if (Object.keys(inputs).length > 0) check.inputs = inputs;
  out.push(check);
  return truth;
}

/**
 * The data a calculated side was worked out from (N218): each market value,
 * indicator, metric, statistic or position inside a calculation, by its id.
 * "close 1 bar ago × 1.03" then shows the close it multiplied. Position
 * values add `<id>:entry`, `<id>:peak` and `<id>:close`.
 */
function calcInputs(
  exprs: (Expr | undefined)[],
  r: SeriesResolver,
  now?: string,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const iso = (t: number | undefined) => (t === undefined ? null : new Date(t).toISOString());
  const visit = (e: Expr, inCalc: boolean) => {
    if (e.kind === 'calc') e.args.forEach((a) => visit(a, true));
    else if (inCalc && e.kind !== 'constant') out[e.id] = num(evaluateExpr(e, r));
    // Which bar a price or indicator came from (N224).
    // Which bar a price or indicator came from, when not the bar just checked (N224).
    if ((e.kind === 'market' || e.kind === 'indicator') && r.barEnd) {
      const at = iso(r.barEnd(e, 0));
      if (at !== now) out[`${e.id}:at`] = at;
    }
    // A position value says what it was worked out from: the entry price, and for
    // the trailing stop the best close since entry and the close checked (ADR 0074).
    if (e.kind === 'position') {
      const p = r.position?.(e.instrumentId);
      if (!p || p.quantity.isZero()) return;
      out[`${e.id}:entry`] = num(p.averagePrice);
      if (p.openedAt !== undefined) out[`${e.id}:opened`] = iso(p.openedAt);
      if (p.checkCloseAt !== undefined) out[`${e.id}:closeAt`] = iso(p.checkCloseAt);
      if (e.field === 'days_held' && p.daysHeld !== undefined)
        out[`${e.id}:days`] = String(p.daysHeld);
      // Gain and P/L read the latest close of the position's own bars.
      if (e.field === 'gain_pct' || e.field === 'pnl') {
        const mark = markExpr(e);
        out[`${e.id}:mark`] = num(r.value(mark, 0));
        if (r.barEnd) out[`${e.id}:markAt`] = iso(r.barEnd(mark, 0));
      }
      if (e.field === 'off_peak_pct') {
        out[`${e.id}:peak`] = num(p.peak);
        out[`${e.id}:close`] = num(p.checkClose);
      }
      // The ATR and expected-move exits as values (N221): what was fixed at entry, and the close.
      if (e.field === 'atrs_below_entry') {
        out[`${e.id}:atr`] = num(p.atrAtEntry?.[e.period ?? DEFAULT_HOLDING_ATR_PERIOD]);
        out[`${e.id}:close`] = num(p.checkClose);
      }
      if (e.field === 'expected_moves_1d' || e.field === 'expected_moves_5d') {
        out[`${e.id}:move`] = num(p.moveAtEntry?.[e.field === 'expected_moves_1d' ? 1 : 5]);
        out[`${e.id}:close`] = num(p.checkClose);
      }
    }
  };
  for (const e of exprs) if (e) visit(e, false);
  return out;
}

/** Every node's check on one evaluation, for a record outside the bar logs (N218). */
export function conditionChecks(
  node: ConditionNode,
  r: SeriesResolver,
  now?: string,
): { truth: StoredTruth; checks: ConditionCheck[] } {
  const checks: ConditionCheck[] = [];
  const truth = stored(checksFor(node, r, checks, now));
  return { truth, checks };
}

/** The as-of dates of the options signals a comparison read on this bar. */
function optionDates(exprs: (Expr | undefined)[], r: SeriesResolver): string[] {
  const dates = new Set<string>();
  const visit = (e: Expr | undefined) => {
    if (!e) return;
    if (e.kind === 'metric') {
      const field = optionMetricField(e.metric);
      const p = field ? r.option?.(e.instrumentId, field, 0) : undefined;
      if (p) dates.add(p.source === 'rebuilt' ? `${p.asOfDate} (rebuilt)` : p.asOfDate);
    } else if (e.kind === 'calc') e.args.forEach(visit);
    else if (e.kind === 'stat') visit(e.input);
  };
  exprs.forEach(visit);
  return [...dates];
}

/**
 * The records the earnings, deal and rate metrics of a comparison read on this
 * bar (ADR 0058), in words with their dates (N224): the earnings release, the
 * next earnings date and where it came from, the deal, the T-bill rate's day.
 * The earnings window names both dates and which day of the window the bar was.
 */
function eventDates(exprs: (Expr | undefined)[], r: SeriesResolver): string[] {
  const dates = new Set<string>();
  const rebuilt = (note: string | undefined) => (note === 'rebuilt' ? ' (rebuilt history)' : '');
  const coming = (note: string | undefined) =>
    note === 'edgar'
      ? ' (the actual EDGAR release, as the earnings calendar did not list it yet)'
      : ' (earnings calendar)';
  const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
  const visit = (e: Expr | undefined) => {
    if (!e) return;
    if (e.kind === 'metric') {
      if (e.metric === 'earnings.window') {
        const since = r.event?.(e.instrumentId, 'earnings.days_since_earnings', 0);
        const next = r.event?.(e.instrumentId, 'earnings.next_date_days', 0);
        if (since)
          dates.add(
            `Last earnings release ${since.asOfDate}${rebuilt(since.note)}: this bar is day ${signed(since.value.toNumber())}`,
          );
        if (next)
          dates.add(
            `Next earnings ${next.asOfDate}${coming(next.note)}: this bar is day ${signed(-next.value.toNumber())}`,
          );
        if (!since && !next) dates.add('No earnings dates on record');
        return;
      }
      if (!isEventMetricId(e.metric)) return;
      const p = r.event?.(e.instrumentId, e.metric, 0);
      if (!p) return;
      if (e.metric === 'earnings.next_earnings_days' || e.metric === 'earnings.next_date_days')
        dates.add(`Next earnings ${p.asOfDate}${coming(p.note)}`);
      else if (e.metric.startsWith('earnings.'))
        dates.add(`Earnings release ${p.asOfDate}${rebuilt(p.note)}`);
      else if (e.metric.startsWith('deals.'))
        dates.add(p.note ? `Deal ${p.note} of ${p.asOfDate}` : `Deal of ${p.asOfDate}`);
      else dates.add(`T-bill rate of ${p.asOfDate}`);
    } else if (e.kind === 'calc') e.args.forEach(visit);
    else if (e.kind === 'stat') visit(e.input);
  };
  exprs.forEach(visit);
  return [...dates];
}

/** Why a true condition did not fire, from the trigger state before and after the step. */
export function whyNotFired(
  before: TriggerState,
  after: TriggerState,
  now: number,
  trigger: Trigger,
): ConditionOutcome {
  void now;
  if (after.consecutive < trigger.confirmationBars + 1) return 'confirming';
  if (inCooldown(after, trigger)) return 'cooldown';
  if (trigger.mode === 'once_per_cycle' && before.fired > 0) return 'fired_before';
  return 'already_true';
}

export class ConditionRecorder {
  private readonly bars: ConditionBar[] = [];
  private readonly summaries = new Map<string, ComparisonSummary>();
  private evaluated = 0;
  private trueBars = 0;
  private falseBars = 0;
  private unknownBars = 0;
  private fired = 0;

  constructor(
    private readonly condition: ConditionNode,
    /** Absent for a slot's Exit, which has no trigger (ADR 0049). */
    private readonly trigger: Trigger | undefined,
  ) {
    const walk = (node: ConditionNode) => {
      if (node.kind === 'group') node.children.forEach(walk);
      else
        this.summaries.set(node.id, {
          id: node.id,
          trueBars: 0,
          falseBars: 0,
          unknownBars: 0,
          firstTrue: null,
          lastTrue: null,
        });
    };
    walk(condition);
  }

  /** Records one evaluation and returns its row, so the caller can set the outcome. */
  record(time: string, r: SeriesResolver, cycle?: number): ConditionBar {
    const checks: ConditionCheck[] = [];
    const truth = stored(checksFor(this.condition, r, checks, time));
    this.evaluated += 1;
    if (truth === true) this.trueBars += 1;
    else if (truth === false) this.falseBars += 1;
    else this.unknownBars += 1;
    for (const c of checks) {
      const s = this.summaries.get(c.id);
      if (!s) continue;
      if (c.truth === true) {
        s.trueBars += 1;
        s.firstTrue ??= time;
        s.lastTrue = time;
      } else if (c.truth === false) s.falseBars += 1;
      else s.unknownBars += 1;
    }
    const row: ConditionBar = { time, truth, checks };
    if (cycle !== undefined) row.cycle = cycle;
    this.bars.push(row);
    return row;
  }

  markFired(row: ConditionBar, outcome: ConditionOutcome = 'fired') {
    row.outcome = outcome;
    if (outcome === 'fired') this.fired += 1;
  }

  report(): PhaseConditionReport {
    let bars = this.bars;
    const barsTruncated = bars.length > MAX_CONDITION_BARS;
    if (barsTruncated) {
      // Keep what explains the result: true bars, firings and changes of truth.
      bars = bars.filter(
        (b, i) => b.truth === true || b.outcome !== undefined || b.truth !== bars[i - 1]?.truth,
      );
      if (bars.length > MAX_CONDITION_BARS) {
        bars = bars.filter((b) => b.outcome !== undefined).slice(-MAX_CONDITION_BARS);
      }
    }
    return {
      condition: this.condition,
      ...(this.trigger ? { trigger: this.trigger } : {}),
      evaluated: this.evaluated,
      trueBars: this.trueBars,
      falseBars: this.falseBars,
      unknownBars: this.unknownBars,
      fired: this.fired,
      comparisons: [...this.summaries.values()],
      bars,
      barsTruncated,
    };
  }
}
