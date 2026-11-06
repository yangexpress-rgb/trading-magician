import Decimal from 'decimal.js';
import {
  CONTEXT_INSTRUMENT_ID,
  evaluateCondition,
  withContext,
  type SeriesResolver,
  type Truth,
} from './evaluate';
import { computeMetric, metricExprRef, metricReferences, metricRequirements } from './metrics';
import type {
  ConditionGroup,
  Expr,
  IndicatorExpr,
  MarketExpr,
  MetricRef,
  PlannedOrder,
  Selection,
  StrategyDefinition,
} from './schema';
import { scheduleOf } from './schedule';
import { walkComparisons, walkExpr, walkExpressions } from './tree';
import { markExpr } from './evaluate';

/**
 * Selection groups and per-leg conditions (Design v1.2 items 1 and 2) as pure
 * functions the back tester and the paper runtime share.
 *
 * Both turn an Entry into "slots": one per universe member (selection) or one
 * per Entry leg (legs). Each slot holds at most one cycle at a time, and a
 * slot's cycle runs the ordinary Entry-then-Exit machinery on a slot
 * definition: that slot's one Entry leg and the Exit legs for its
 * instrument. A v1.1 strategy has no slots and runs exactly as before.
 */

export type SlotMode = 'none' | 'selection' | 'legs';

export function slotModeOf(def: StrategyDefinition): SlotMode {
  if (def.entry.kind === 'selection') return 'selection';
  if (def.entry.orders.some((o) => o.legCondition) || def.entry.fireMode?.mode === 'bestByMetric')
    return 'legs';
  return 'none';
}

export interface Slot {
  /** The Entry leg, or the Selection group's template leg. */
  legId: string;
  instrumentId: string;
}

export const slotKey = (s: Slot) => `${s.legId}|${s.instrumentId}`;

/** How many members a Selection group holds: N, or a percentage rounded down, at least 1. */
export function selectionCount(selection: Selection, universeSize: number): number {
  if (selection.count.type === 'fixed') return selection.count.value;
  return Math.max(1, Math.floor((universeSize * selection.count.value) / 100));
}

/** A universe's instruments: a list as given, or a built-in one resolved by the caller. */
export function universeMembers(
  selection: Selection,
  builtin: (id: 'sp500') => readonly string[],
): string[] {
  const ids =
    selection.universe.type === 'list' ? selection.universe.instrumentIds : builtin('sp500');
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Ranking (item 1)
// ---------------------------------------------------------------------------

export type ExclusionReason = 'filter_false' | 'filter_unknown' | 'no_value';

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  filter_false: 'Failed the pre-filter',
  filter_unknown: 'Pre-filter could not be evaluated (not enough data)',
  no_value: 'No metric value: fewer bars than the lookback needs, or a missing price',
};

export interface RankingRow {
  instrumentId: string;
  symbol: string;
  /** The ranking metric's value, or null when it can't be worked out (never 0). */
  value: string | null;
  /** The pre-filter's result: true when there is none, null when unknown. */
  filter: boolean | null;
  /** 1 for the best ranked member; null when left out of the ranking. */
  rank: number | null;
  selected: boolean;
  excluded: ExclusionReason | null;
}

export interface RankingResult {
  rows: RankingRow[];
  selected: string[];
  count: number;
}

/**
 * Scores every member as of the bar being evaluated, applies the pre-filter,
 * sorts and takes the top N. Ties break by symbol, alphabetically, so runs
 * are reproducible; a null metric or a failing pre-filter leaves a member
 * out; fewer passing members than N means holding only those, and none
 * means cash.
 */
export function rankUniverse(
  selection: Selection,
  members: readonly string[],
  view: SeriesResolver,
  symbolOf: (id: string) => string,
): RankingResult {
  const count = selectionCount(selection, members.length);
  const scored = members.map((instrumentId) => {
    const r = withContext(view, instrumentId);
    const filter: Truth =
      selection.preFilter && hasComparisons(selection.preFilter)
        ? evaluateCondition(selection.preFilter, r)
        : true;
    const value = computeMetric(selection.ranking, instrumentId, r);
    const excluded: ExclusionReason | null =
      filter === false
        ? 'filter_false'
        : filter === undefined
          ? 'filter_unknown'
          : value === undefined
            ? 'no_value'
            : null;
    return { instrumentId, symbol: symbolOf(instrumentId), value, filter, excluded };
  });
  const ranked = scored
    .filter((s) => s.excluded === null)
    .sort((a, b) => {
      const byValue =
        selection.direction === 'desc'
          ? (b.value as Decimal).comparedTo(a.value as Decimal)
          : (a.value as Decimal).comparedTo(b.value as Decimal);
      return byValue || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
    });
  const selected = ranked.slice(0, count).map((s) => s.instrumentId);
  const rankOf = new Map(ranked.map((s, i) => [s.instrumentId, i + 1]));
  const chosen = new Set(selected);
  const rows: RankingRow[] = [
    ...ranked,
    ...scored
      .filter((s) => s.excluded !== null)
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)),
  ].map((s) => ({
    instrumentId: s.instrumentId,
    symbol: s.symbol,
    value: s.value === undefined ? null : s.value.toString(),
    filter: s.filter ?? null,
    rank: rankOf.get(s.instrumentId) ?? null,
    selected: chosen.has(s.instrumentId),
    excluded: s.excluded,
  }));
  return { rows, selected, count };
}

// ---------------------------------------------------------------------------
// Per-leg conditions (item 2)
// ---------------------------------------------------------------------------

export function hasComparisons(g: ConditionGroup): boolean {
  for (const _ of walkComparisons(g)) return true;
  return false;
}

export interface LegRow {
  legId: string;
  instrumentId: string;
  symbol: string;
  /** Entry condition and leg condition together; null when unknown. */
  passed: boolean | null;
  /** The fire-mode metric, for best-by-metric. */
  value: string | null;
  selected: boolean;
}

/**
 * Which Entry legs qualify on this bar: a leg fires only when the Entry
 * condition (when it has one) and its own leg condition are both true; a
 * leg without a leg condition follows the Entry condition alone. Under
 * best-by-metric only the qualifying leg with the highest metric value
 * fires (ties by symbol); a leg whose metric is null can't be compared and
 * doesn't fire.
 */
export function selectLegs(
  def: StrategyDefinition,
  view: SeriesResolver,
  symbolOf: (id: string) => string,
): { rows: LegRow[]; selected: Slot[] } {
  const phase: Truth = hasComparisons(def.entry.condition)
    ? evaluateCondition(def.entry.condition, view)
    : true;
  const fire = def.entry.fireMode;
  const rows: LegRow[] = def.entry.orders.map((o) => {
    const r = withContext(view, o.instrumentId);
    const own: Truth =
      o.legCondition && hasComparisons(o.legCondition)
        ? evaluateCondition(o.legCondition, r)
        : true;
    const passed: Truth =
      phase === false || own === false
        ? false
        : phase === undefined || own === undefined
          ? undefined
          : true;
    const value =
      fire?.mode === 'bestByMetric' ? computeMetric(fire.metric, o.instrumentId, r) : undefined;
    return {
      legId: o.id,
      instrumentId: o.instrumentId,
      symbol: symbolOf(o.instrumentId),
      passed: passed ?? null,
      value: value === undefined ? null : value.toString(),
      selected: false,
    };
  });
  let chosen = rows.filter((r) => r.passed === true);
  if (fire?.mode === 'bestByMetric') {
    const best = chosen
      .filter((r) => r.value !== null)
      .sort(
        (a, b) =>
          new Decimal(b.value as string).comparedTo(new Decimal(a.value as string)) ||
          (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
      )[0];
    chosen = best ? [best] : [];
  }
  for (const r of chosen) r.selected = true;
  return {
    rows,
    selected: chosen.map((r) => ({ legId: r.legId, instrumentId: r.instrumentId })),
  };
}

// ---------------------------------------------------------------------------
// Slots: what to enter and exit on an evaluation
// ---------------------------------------------------------------------------

export interface HeldSlot {
  key: string;
  /** Cycle id (runtime) or number (back test), as the caller knows it. */
  id: string;
  /** Only an open position is exited by a rebalance; one still entering is left alone. */
  open: boolean;
}

export interface SlotPlan {
  enter: Slot[];
  /** Held slots whose cycles exit because the selection moved on. */
  exit: string[];
}

/**
 * Selection groups rebalance on every evaluation: members selected but not
 * held are entered, held members no longer selected are exited, and held
 * members still selected are kept (no selling and buying back). Per-leg
 * conditions keep entry-only semantics on a daily schedule, so legs fire
 * only when the strategy holds nothing, as a v1.1 cycle does; on a
 * calendar schedule each scheduled evaluation re-selects the legs the same
 * way a Selection group does. Exits from the Exit condition and exit rules
 * are separate and run on every bar.
 */
export function planSlots(input: {
  mode: Exclude<SlotMode, 'none'>;
  scheduled: boolean;
  candidates: readonly Slot[];
  held: readonly HeldSlot[];
  /** New entries are halted (daily loss, drawdown, kill switch or pause). */
  halted: boolean;
}): SlotPlan {
  const wanted = new Set(input.candidates.map(slotKey));
  const heldKeys = new Set(input.held.map((h) => h.key));
  const rebalance = input.mode === 'selection' || input.scheduled;
  const exit = rebalance
    ? input.held.filter((h) => h.open && !wanted.has(h.key)).map((h) => h.id)
    : [];
  let enter: Slot[];
  if (input.halted) enter = [];
  else if (!rebalance) enter = input.held.length === 0 ? [...input.candidates] : [];
  else enter = input.candidates.filter((c) => !heldKeys.has(slotKey(c)));
  return { enter, exit };
}

export function isScheduled(def: StrategyDefinition): boolean {
  return scheduleOf(def) !== 'daily';
}

const bindOrder = (o: PlannedOrder, instrumentId: string): PlannedOrder =>
  o.instrumentId === CONTEXT_INSTRUMENT_ID ? { ...o, instrumentId } : o;

/**
 * The definition a slot's cycle runs: the slot's Entry leg bound to its
 * instrument (a Selection group's sizing split equally across the N
 * selections) and the Exit legs for that instrument. Everything else,
 * including conditions, is the strategy's own; conditions read the slot's
 * instrument through `withContext`.
 */
export function slotDefinition(def: StrategyDefinition, slot: Slot, count = 1): StrategyDefinition {
  const template = def.entry.orders.find((o) => o.id === slot.legId);
  if (!template) throw new Error(`No Entry leg ${slot.legId}`);
  const { legCondition: _drop, ...leg } = bindOrder(template, slot.instrumentId);
  void _drop;
  const entry: PlannedOrder =
    def.entry.kind === 'selection' && count > 1
      ? {
          ...leg,
          quantity: {
            ...leg.quantity,
            value: new Decimal(leg.quantity.value).div(count).toDecimalPlaces(10).toString(),
          },
        }
      : leg;
  const exits = def.exit.orders
    .filter((o) => o.instrumentId === CONTEXT_INSTRUMENT_ID || o.instrumentId === slot.instrumentId)
    .map((o) => bindOrder(o, slot.instrumentId));
  return {
    ...def,
    entry: { ...def.entry, orders: [entry] },
    exit: { ...def.exit, orders: exits },
    execution: { ...def.execution, legOrder: undefined },
  };
}

// ---------------------------------------------------------------------------
// Data the rules read
// ---------------------------------------------------------------------------

export type SeriesNeed = MarketExpr | IndicatorExpr;

/** Every condition tree of a definition, with where it lives. */
export function conditionTrees(def: StrategyDefinition): { tree: ConditionGroup; where: string }[] {
  const out = [
    { tree: def.entry.condition, where: 'entry' },
    { tree: def.exit.condition, where: 'exit' },
  ];
  for (const o of def.entry.orders)
    if (o.legCondition) out.push({ tree: o.legCondition, where: `leg:${o.id}` });
  if (def.entry.selection?.preFilter)
    out.push({ tree: def.entry.selection.preFilter, where: 'preFilter' });
  return out;
}

/** Every expression in conditions and order prices. */
export function definitionExpressions(def: StrategyDefinition): Expr[] {
  const all: Expr[] = [];
  for (const { tree } of conditionTrees(def)) all.push(...walkExpressions(tree));
  for (const o of [...def.entry.orders, ...def.exit.orders]) {
    if (o.limitPrice) all.push(...walkExpr(o.limitPrice));
    if (o.stopPrice) all.push(...walkExpr(o.stopPrice));
  }
  return all;
}

/** Instruments a slot can stand for: universe members, or the Entry legs' instruments. */
export function contextInstruments(def: StrategyDefinition, members: readonly string[]): string[] {
  if (def.entry.kind === 'selection') return [...members];
  return [...new Set(def.entry.orders.map((o) => o.instrumentId))].filter(
    (id) => id !== CONTEXT_INSTRUMENT_ID,
  );
}

/** Metric references a definition ranks or fires by. */
function definitionMetrics(def: StrategyDefinition): MetricRef[] {
  const refs: MetricRef[] = [];
  if (def.entry.kind === 'selection' && def.entry.selection) refs.push(def.entry.selection.ranking);
  if (def.entry.fireMode?.mode === 'bestByMetric') refs.push(def.entry.fireMode.metric);
  return refs;
}

/**
 * The bar series a definition reads, for loading data ahead of a run. An
 * expression inside a statistical function is listed further back by the
 * function's window, so its whole history is loaded; metrics list the daily
 * series they read; "this instrument" expands to every member or leg.
 */
export function definitionSeries(
  def: StrategyDefinition,
  members: readonly string[] = [],
): SeriesNeed[] {
  const contexts = contextInstruments(def, members);
  const out: SeriesNeed[] = [];
  const bindAll = (e: SeriesNeed): SeriesNeed[] =>
    e.instrumentId === CONTEXT_INSTRUMENT_ID
      ? contexts.map((id) => ({ ...e, instrumentId: id }))
      : [e];
  const visit = (e: Expr, extra: number) => {
    switch (e.kind) {
      case 'constant':
        return;
      case 'market':
      case 'indicator':
        out.push(...bindAll({ ...e, offset: e.offset + extra }));
        return;
      case 'position':
        out.push(...bindAll(markExpr(e)));
        return;
      case 'metric': {
        const ids = e.instrumentId === CONTEXT_INSTRUMENT_ID ? contexts : [e.instrumentId];
        for (const id of ids)
          for (const s of metricRequirements(metricExprRef(e), id))
            out.push({ ...s, offset: s.offset + extra });
        return;
      }
      case 'stat':
        visit(e.input, extra + e.period - 1 + (e.offset ?? 0));
        return;
      case 'calc':
        for (const a of e.args) visit(a, extra);
        return;
    }
  };
  for (const { tree } of conditionTrees(def))
    for (const c of walkComparisons(tree)) {
      for (const side of [c.left, c.right, c.upper]) if (side) visit(side, 0);
    }
  for (const o of [...def.entry.orders, ...def.exit.orders]) {
    if (o.limitPrice) visit(o.limitPrice, 0);
    if (o.stopPrice) visit(o.stopPrice, 0);
  }
  for (const ref of definitionMetrics(def)) {
    for (const id of contexts) out.push(...metricRequirements(ref, id));
  }
  return out;
}

/** Instruments a definition reads besides its legs: benchmarks and fixed references. */
export function referencedInstruments(def: StrategyDefinition): string[] {
  const ids = new Set<string>();
  for (const e of definitionExpressions(def)) {
    if ('instrumentId' in e && e.instrumentId !== CONTEXT_INSTRUMENT_ID) ids.add(e.instrumentId);
    if (e.kind === 'metric') for (const id of metricReferences(metricExprRef(e))) ids.add(id);
  }
  for (const ref of definitionMetrics(def)) for (const id of metricReferences(ref)) ids.add(id);
  return [...ids];
}

/** A list universe's members; a built-in one is resolved by the caller. */
export function listMembers(def: StrategyDefinition): string[] {
  const u = def.entry.kind === 'selection' ? def.entry.selection?.universe : undefined;
  return u?.type === 'list' ? [...new Set(u.instrumentIds)] : [];
}

/** Largest list universe a paper run takes; every member's bars load on each pass. */
export const PAPER_UNIVERSE_LIMIT = 50;

/**
 * Why a strategy can be back tested but not yet run on paper, or undefined.
 * Open decision (design v1.2 N13, O17): S&P 500 Selection groups back test in this round
 * and run on paper once the worker caches bars (Design v1.2 N11).
 */
export function paperRunBlocker(def: StrategyDefinition): string | undefined {
  if (def.entry.kind !== 'selection') return undefined;
  const u = def.entry.selection?.universe;
  if (u?.type === 'builtin')
    return 'S&P 500 Selection groups can be back tested, but not run on paper yet: the paper runtime would reload 500 stocks’ bars on every pass. Use a list of up to 50 instruments to run on paper.';
  if (u?.type === 'list' && new Set(u.instrumentIds).size > PAPER_UNIVERSE_LIMIT)
    return `Paper runs take list universes of up to ${PAPER_UNIVERSE_LIMIT} instruments; this one has ${new Set(u.instrumentIds).size}. It can still be back tested.`;
  return undefined;
}
