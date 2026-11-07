import Decimal from 'decimal.js';
import { assertAllowedTradingMode } from '../trading-mode';
import { DEMO_VENUE_CODE } from '../integrations/providers';
import { isIndicatorOnlyClass } from '../market/indices';
import { checkIndicatorParams, getIndicator, QUOTE_FIELDS } from './catalog';
import {
  REQUIRED_RISK_LIMITS,
  type Comparison,
  type ConditionGroup,
  type ConditionNode,
  type Expr,
  type OrderSide,
  type PhaseName,
  type PlannedOrder,
  type StrategyDefinition,
} from './schema';
import { extendedHoursEligible } from './extended-hours';
import { groupDefinition } from './groups';
import { checkTiming } from './timing';
import { exprDepth, treeDepth, walkComparisons, walkExpr, walkExpressions } from './tree';
import { CONTEXT_INSTRUMENT_ID } from './evaluate';
import { checkMetricRef, getMetric, metricReferences } from './metrics';
import { hasComparisons, paperRunBlocker, slotModeOf, usesFundamentals } from './selection';
import type { MetricRef } from './schema';

/**
 * Validation before save and activation (Design v1.0 §6.10).
 *
 * Errors block activation; warnings must be acknowledged. Saving a draft is
 * always allowed so people can work incrementally; the editor shows the same
 * issues live.
 */

export type Severity = 'error' | 'warning';
export interface ValidationIssue {
  severity: Severity;
  code: string;
  message: string;
  /** Path into the definition, e.g. ['entry', 'orders', 0, 'side']. */
  path: (string | number)[];
  /** Condition node or leg the issue belongs to, for highlighting in the editor. */
  nodeId?: string;
}

export interface InstrumentInfo {
  symbol: string;
  assetClass: string;
  lotSize: string;
  /** Listing venue; demo instruments have their own (ADR 0016). */
  venue?: string | undefined;
  /** Whether the broker lends it for short selling; absent or null when unknown (v1.2 item 8). */
  shortable?: boolean | null | undefined;
}

export interface AccountCapabilities {
  assetClasses: readonly string[];
  orderTypes: readonly string[];
  timeInForce: readonly string[];
  sides: readonly string[];
  extendedHours: boolean;
  shortSelling: boolean;
  fractionalQuantity: boolean;
  atomicMultiLeg: boolean;
  /** Which instruments the account can trade: the demo ones, or real US listings (ADR 0018). */
  coverage?: 'demo' | 'us' | undefined;
}

export interface AccountInfo {
  nickname: string;
  mode: string;
  isActive: boolean;
  capabilities: AccountCapabilities;
}

export interface ValidationContext {
  instruments: ReadonlyMap<string, InstrumentInfo>;
  accounts: ReadonlyMap<string, AccountInfo>;
  /** Whether an active feed route covers this asset class and data type. */
  hasFeed: (assetClass: string, dataType: 'quotes' | 'bars') => boolean;
  /** Whether an active company data feed (SEC EDGAR) is on, for fundamental metrics (v1.2 item 6). */
  hasCompanyFeed?: boolean;
  now: Date;
  /** Latest successful back test for this strategy; arrives with Phase 2. */
  backtest?: { definitionHash: string; completedAt: Date } | null;
  /** Hash of the definition being validated, compared with the back test's. */
  definitionHash?: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export const LIMITS = {
  maxConditionDepth: 6,
  maxExpressionDepth: 6,
  maxComparisonsPerPhase: 50,
  maxLegsPerPhase: 20,
} as const;

const OPENING_SIDES: readonly OrderSide[] = ['buy', 'sell_short'];

export function validateStrategy(
  def: StrategyDefinition,
  ctx: ValidationContext,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (
    severity: Severity,
    code: string,
    message: string,
    path: (string | number)[],
    nodeId?: string,
  ) => issues.push({ severity, code, message, path, ...(nodeId ? { nodeId } : {}) });

  checkUniqueIds(def, add);

  for (const phase of ['entry', 'exit'] as const) {
    checkCondition(def, phase, ctx, add);
    checkOrders(def, phase, ctx, add);
  }
  checkSlots(def, ctx, add);
  checkExitExposure(def, add);
  checkPositionValues(def, add);
  checkExecution(def, add);
  checkRisk(def, ctx, add);
  checkFundamentals(def, ctx, add);

  for (const p of checkTiming(def)) {
    const index = def[p.phase].orders.findIndex((o) => o.id === p.legId);
    add('error', p.code, p.message, [p.phase, 'orders', index, 'timing'], p.legId);
  }

  // Entry groups (v1.2 item 8): each is checked as the strategy's own Entry and Exit are.
  (def.groups ?? []).forEach((g, i) => {
    const gdef = groupDefinition(def, g.id);
    const at: Add = (severity, code, message, path, nodeId) =>
      add(severity, code, message, ['groups', i, ...path], nodeId);
    for (const phase of ['entry', 'exit'] as const) {
      checkCondition(gdef, phase, ctx, at);
      checkOrders(gdef, phase, ctx, at);
    }
    checkExitExposure(gdef, at);
    checkPositionValues(gdef, at);
    for (const p of checkTiming(gdef)) {
      const index = gdef[p.phase].orders.findIndex((o) => o.id === p.legId);
      at('error', p.code, p.message, [p.phase, 'orders', index, 'timing'], p.legId);
    }
  });

  checkGroups(def, ctx, add);
  checkAtrStops(def, add);
  checkBacktest(ctx, add);

  return {
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

type Add = (
  severity: Severity,
  code: string,
  message: string,
  path: (string | number)[],
  nodeId?: string,
) => void;

// ---------------------------------------------------------------------------

function checkUniqueIds(def: StrategyDefinition, add: Add) {
  const seen = new Set<string>();
  const labels = new Map<string, number>();
  const visitNode = (n: ConditionNode) => {
    if (seen.has(n.id)) add('error', 'duplicate_id', 'The definition has duplicate ids', [], n.id);
    seen.add(n.id);
    if (n.kind === 'group') n.children.forEach(visitNode);
  };
  for (const o of def.entry.orders) if (o.legCondition) visitNode(o.legCondition);
  if (def.entry.selection?.preFilter) visitNode(def.entry.selection.preFilter);
  for (const r of def.exit.rules ?? []) {
    if (seen.has(r.id)) add('error', 'duplicate_id', 'The definition has duplicate ids', [], r.id);
    seen.add(r.id);
  }
  const parts = [
    { p: def as { entry: StrategyDefinition['entry']; exit: StrategyDefinition['exit'] }, at: [] },
    ...(def.groups ?? []).map((g, i) => ({ p: g, at: ['groups', i] as (string | number)[] })),
  ];
  for (const g of def.groups ?? []) {
    if (seen.has(g.id)) add('error', 'duplicate_id', 'The definition has duplicate ids', [], g.id);
    seen.add(g.id);
    for (const r of g.exit.rules ?? []) {
      if (seen.has(r.id))
        add('error', 'duplicate_id', 'The definition has duplicate ids', [], r.id);
      seen.add(r.id);
    }
  }
  for (const { p: part, at } of parts)
    for (const phase of ['entry', 'exit'] as const) {
      visitNode(part[phase].condition);
      part[phase].orders.forEach((o, i) => {
        if (seen.has(o.id))
          add(
            'error',
            'duplicate_id',
            'The definition has duplicate ids',
            [...at, phase, 'orders', i],
            o.id,
          );
        seen.add(o.id);
        const label = o.legLabel.trim().toLowerCase();
        labels.set(label, (labels.get(label) ?? 0) + 1);
        if (labels.get(label) === 2) {
          add(
            'error',
            'duplicate_leg_label',
            `Two legs are named "${o.legLabel}"; give each leg its own name`,
            [...at, phase, 'orders', i, 'legLabel'],
            o.id,
          );
        }
      });
    }
}

// ---------------------------------------------------------------------------
// Conditions

function checkCondition(
  def: StrategyDefinition,
  phase: PhaseName,
  ctx: ValidationContext,
  add: Add,
) {
  const root = def[phase].condition;
  const label = phase === 'entry' ? 'Entry' : 'Exit';
  const comparisons = [...walkComparisons(root)];

  if (comparisons.length === 0) {
    const allTimingOnly =
      def[phase].orders.length > 0 && def[phase].orders.every((o) => o.timingOnly);
    // A Selection group or per-leg conditions decide entries themselves, and an
    // exit rule such as the time stop can be the only exit (v1.2).
    // A rebalance (Selection group, or per-leg conditions on a calendar
    // schedule) exits what is no longer selected.
    const mode = slotModeOf(def);
    const decidedElsewhere =
      phase === 'entry'
        ? mode !== 'none'
        : (def.exit.rules?.length ?? 0) > 0 ||
          mode === 'selection' ||
          (mode === 'legs' && (def.schedule?.frequency ?? 'daily') !== 'daily');
    if (!allTimingOnly && !decidedElsewhere) {
      add(
        'error',
        'empty_condition',
        `Add at least one ${label} condition`,
        [phase, 'condition'],
        root.id,
      );
    }
  }
  if (comparisons.length > LIMITS.maxComparisonsPerPhase) {
    add(
      'error',
      'too_many_conditions',
      `${label} has more than ${LIMITS.maxComparisonsPerPhase} conditions`,
      [phase, 'condition'],
    );
  }
  if (treeDepth(root) > LIMITS.maxConditionDepth) {
    add(
      'error',
      'condition_too_deep',
      `${label} groups are nested more than ${LIMITS.maxConditionDepth} levels deep`,
      [phase, 'condition'],
    );
  }

  // "This instrument" means the slot's instrument, which exists in Exit rules of
  // a Selection group or per-leg strategy; the strategy-level Entry has none.
  const context = phase === 'exit' && slotModeOf(def) !== 'none';
  checkTree(root, [phase, 'condition'], ctx, add, context);
}

function checkTree(
  root: ConditionGroup,
  rootPath: (string | number)[],
  ctx: ValidationContext,
  add: Add,
  context: boolean,
) {
  const visitGroup = (g: ConditionGroup, path: (string | number)[]) => {
    if (g !== root && g.children.length === 0) {
      add('error', 'empty_group', 'This group is empty; add a condition or remove it', path, g.id);
    }
    g.children.forEach((c, i) => {
      const childPath = [...path, 'children', i];
      if (c.kind === 'group') visitGroup(c, childPath);
      else checkComparison(c, childPath, ctx, add, context);
    });
  };
  visitGroup(root, rootPath);
}

function isSeries(e: Expr): boolean {
  return (
    e.kind === 'market' ||
    e.kind === 'indicator' ||
    e.kind === 'position' ||
    e.kind === 'metric' ||
    e.kind === 'stat'
  );
}

function containsSeries(e: Expr): boolean {
  for (const x of walkExpr(e)) if (isSeries(x)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// ATR stop (v1.2 item 9)

function checkAtrStops(def: StrategyDefinition, add: Add) {
  const parts = [
    { p: def as Pick<StrategyDefinition, 'entry' | 'exit'>, at: [] as (string | number)[] },
    ...(def.groups ?? []).map((g, i) => ({ p: g, at: ['groups', i] })),
  ];
  for (const { p, at } of parts) {
    const rules = p.exit.rules ?? [];
    const stops = rules.filter((r) => r.kind === 'atrStop');
    if (stops.length > 1)
      add('error', 'duplicate_atr_stop', 'Use one ATR stop per Exit', [...at, 'exit', 'rules']);
    const instruments = new Set(p.entry.orders.map((o) => o.instrumentId));
    if (stops.length > 0 && instruments.size > 1)
      add(
        'warning',
        'atr_stop_first_leg',
        "The ATR stop watches the first Entry leg's instrument and closes every leg when it fires",
        [...at, 'exit', 'rules'],
      );
  }
}

// ---------------------------------------------------------------------------
// Entry groups and direction (v1.2 item 8)

function checkGroups(def: StrategyDefinition, ctx: ValidationContext, add: Add) {
  const groups = def.groups ?? [];
  const all = [
    { entry: def.entry, path: [] as (string | number)[], label: 'Entry' },
    ...groups.map((g, i) => ({ entry: g.entry, path: ['groups', i], label: g.label })),
  ];
  for (const { entry, path, label } of all) {
    // A stated direction must match what the Entry legs do.
    if (entry.direction) {
      const side = entry.direction === 'long' ? 'buy' : 'sell_short';
      entry.orders.forEach((o, i) => {
        if (o.side !== side)
          add(
            'error',
            'direction_side_mismatch',
            entry.direction === 'long'
              ? `"${label}" goes long: its Entry leg "${o.legLabel}" must Buy`
              : `"${label}" goes short: its Entry leg "${o.legLabel}" must Sell short`,
            [...path, 'entry', 'orders', i, 'side'],
            o.id,
          );
      });
    }
    // Shorting needs an instrument the broker lends (unknown is allowed; back tests say so).
    entry.orders.forEach((o, i) => {
      const instrument = ctx.instruments.get(o.instrumentId);
      if (o.side === 'sell_short' && instrument?.shortable === false)
        add(
          'error',
          'not_shortable',
          `${instrument.symbol} can't be sold short: the broker doesn't lend it`,
          [...path, 'entry', 'orders', i, 'instrumentId'],
          o.id,
        );
    });
  }
  if (groups.length === 0) return;

  if (
    slotModeOf(def) !== 'none' ||
    groups.some((g) => slotModeOf(groupDefinition(def, g.id)) !== 'none')
  )
    add(
      'error',
      'groups_fixed_legs_only',
      'Entry groups trade fixed instruments: remove the Selection group, per-leg conditions or "best by metric" before adding another entry group',
      ['groups'],
    );
  if (def.execution.reentry.mode !== 'single_cycle')
    add(
      'error',
      'groups_single_position',
      'A strategy with several entry groups holds one position at a time: set Re-entry to "One cycle at a time"',
      ['execution', 'reentry', 'mode'],
    );
  const labels = new Set<string>(['group 1']);
  groups.forEach((g, i) => {
    const key = g.label.trim().toLowerCase();
    if (labels.has(key))
      add('error', 'duplicate_group_label', `Two entry groups are named "${g.label}"`, [
        'groups',
        i,
        'label',
      ]);
    labels.add(key);
  });
}

const SAME_BAR_FIELDS = new Set(['open', 'high', 'low', 'close']);

/**
 * v1.2 item 7: "close is above HIGHEST(high, n)" with the window ending on the
 * current bar can never be true (a bar's high is never below its own close),
 * and likewise "below LOWEST(low, n)". Returns the warning, or undefined.
 */
function impossibleBreakout(c: Comparison): string | undefined {
  const above = c.operator === 'gt' || c.operator === 'crosses_above';
  const below = c.operator === 'lt' || c.operator === 'crosses_below';
  if (!above && !below) return undefined;
  const pairs: [Expr | undefined, Expr | undefined, boolean][] = [
    [c.left, c.right, above],
    [c.right, c.left, below],
  ];
  for (const [price, extreme, priceAbove] of pairs) {
    if (price?.kind !== 'market' || extreme?.kind !== 'indicator') continue;
    if (!SAME_BAR_FIELDS.has(price.field)) continue;
    const name = priceAbove ? 'HIGHEST' : 'LOWEST';
    const field = priceAbove ? 'high' : 'low';
    if (extreme.name !== name || extreme.field !== field) continue;
    if (
      price.instrumentId !== extreme.instrumentId ||
      price.interval !== extreme.interval ||
      price.adjustment !== extreme.adjustment ||
      price.session !== extreme.session ||
      price.offset < extreme.offset ||
      price.offset > extreme.offset + Number(extreme.params.period ?? 20) - 1
    )
      continue;
    const label = name === 'HIGHEST' ? 'Highest value' : 'Lowest value';
    return (
      `This can never be true: ${label} includes the bar being checked, and its ${field} is never ` +
      `${priceAbove ? 'below' : 'above'} its own ${price.field}. Set ${label}'s "Bars ago" to ` +
      `${price.offset + 1} to compare with the bars before it`
    );
  }
  return undefined;
}

function checkComparison(
  c: Comparison,
  path: (string | number)[],
  ctx: ValidationContext,
  add: Add,
  context = false,
) {
  const sides: [Expr | undefined, string][] = [
    [c.left, 'left'],
    [c.right, 'right'],
    [c.upper, 'upper'],
  ];
  for (const [expr, key] of sides) if (expr) checkExpr(expr, [...path, key], ctx, add, context);

  if (c.operator === 'is_stale' && (c.left.kind === 'metric' || c.left.kind === 'stat')) {
    add(
      'error',
      'state_needs_market_data',
      'Staleness checks need market data or an indicator on the left',
      [...path, 'left'],
      c.id,
    );
  }
  if ((c.operator === 'is_available' || c.operator === 'is_stale') && !isSeries(c.left)) {
    add(
      'error',
      'state_needs_market_data',
      'Availability checks need market data or an indicator on the left',
      [...path, 'left'],
      c.id,
    );
  }
  if (
    (c.operator === 'crosses_above' || c.operator === 'crosses_below') &&
    sides.some(([e]) => e && [...walkExpr(e)].some((x) => x.kind === 'position'))
  ) {
    add(
      'error',
      'cross_on_position',
      'Position values have no history to cross; use "is at least" or "is at most" instead',
      path,
      c.id,
    );
  }
  const never = impossibleBreakout(c);
  if (never) add('warning', 'breakout_includes_current_bar', never, path, c.id);
  const hasSeries = sides.some(([e]) => e && containsSeries(e));
  if (!hasSeries) {
    if (c.operator === 'crosses_above' || c.operator === 'crosses_below') {
      add(
        'error',
        'cross_needs_market_data',
        'A crossing needs market data or an indicator on at least one side',
        path,
        c.id,
      );
    } else {
      add(
        'warning',
        'constant_comparison',
        'This condition compares fixed values only, so it never changes',
        path,
        c.id,
      );
    }
  }
}

function checkExpr(
  expr: Expr,
  path: (string | number)[],
  ctx: ValidationContext,
  add: Add,
  context = false,
) {
  if (exprDepth(expr) > LIMITS.maxExpressionDepth) {
    add(
      'error',
      'expression_too_deep',
      `Calculations are nested more than ${LIMITS.maxExpressionDepth} levels deep`,
      path,
      expr.id,
    );
  }
  const visit = (e: Expr, p: (string | number)[]) => {
    if (e.kind === 'calc') {
      e.args.forEach((a, i) => visit(a, [...p, 'args', i]));
      if (e.op === 'div') {
        const divisor = e.args[1];
        if (divisor?.kind === 'constant' && new Decimal(divisor.value).isZero()) {
          add(
            'error',
            'division_by_zero',
            'This calculation divides by zero',
            [...p, 'args', 1],
            divisor.id,
          );
        }
      }
      return;
    }
    if (e.kind === 'constant') return;
    if (e.kind === 'stat') {
      visit(e.input, [...p, 'input']);
      if (![...walkExpr(e.input)].some(isSeries)) {
        add(
          'error',
          'stat_needs_market_data',
          `${e.fn} needs a price, a calculated expression or an indicator as its input`,
          [...p, 'input'],
          e.id,
        );
      }
      if ([...walkExpr(e.input)].some((x) => x.kind === 'position')) {
        add(
          'error',
          'stat_on_position',
          'Position values have no history, so they cannot feed a statistical function',
          [...p, 'input'],
          e.id,
        );
      }
      return;
    }

    if (e.instrumentId === CONTEXT_INSTRUMENT_ID) {
      if (!context) {
        add(
          'error',
          'context_instrument_misplaced',
          '"This instrument" only works in a leg condition, a Selection group\'s pre-filter, or the Exit rules of such a strategy',
          [...p, 'instrumentId'],
          e.id,
        );
      }
      if (e.kind === 'metric') checkMetric(metricOf(e), [...p, 'params'], e.id, undefined, add);
      return;
    }
    const instrument = ctx.instruments.get(e.instrumentId);
    if (e.kind === 'metric') {
      checkMetric(metricOf(e), [...p, 'params'], e.id, instrument, add);
      for (const ref of metricReferences(metricOf(e))) {
        if (!ctx.instruments.has(ref))
          add('error', 'unknown_instrument', 'Choose a valid benchmark', [...p, 'params'], e.id);
      }
    }
    if (!instrument) {
      add('error', 'unknown_instrument', 'Choose a valid instrument', [...p, 'instrumentId'], e.id);
    } else {
      const dataType = e.kind === 'market' && QUOTE_FIELDS.includes(e.field) ? 'quotes' : 'bars';
      const index = isIndicatorOnlyClass(instrument.assetClass);
      if (index && dataType === 'quotes') {
        add(
          'error',
          'index_daily_only',
          `${instrument.symbol} has daily bars only, no live prices: read its close instead`,
          [...p, 'field'],
          e.id,
        );
      } else if (!ctx.hasFeed(instrument.assetClass, dataType)) {
        add(
          'error',
          'missing_feed',
          `No active data feed covers ${instrument.symbol} ${dataType}`,
          [...p, 'instrumentId'],
          e.id,
        );
      }
      // Index history is end-of-day only (CBOE), v1.2 item 5.
      if (index && (e.kind === 'market' || e.kind === 'indicator') && e.interval !== '1d') {
        add(
          'error',
          'index_daily_only',
          `${instrument.symbol} has daily bars only: choose the 1 day interval`,
          [...p, 'interval'],
          e.id,
        );
      }
    }
    if (e.kind === 'indicator') {
      const spec = getIndicator(e.name);
      if (!spec) {
        add(
          'error',
          'unknown_indicator',
          `"${e.name}" is not a supported indicator`,
          [...p, 'name'],
          e.id,
        );
      } else {
        for (const problem of checkIndicatorParams(spec, e.params)) {
          add('error', 'invalid_indicator_params', problem, [...p, 'params'], e.id);
        }
      }
    }
  };
  visit(expr, path);
}

const metricOf = (e: Extract<Expr, { kind: 'metric' }>): MetricRef => ({
  metric: e.metric,
  params: e.params,
});

function checkMetric(
  ref: MetricRef,
  path: (string | number)[],
  nodeId: string | undefined,
  instrument: InstrumentInfo | undefined,
  add: Add,
) {
  for (const problem of checkMetricRef(ref)) add('error', 'invalid_metric', problem, path, nodeId);
  const spec = getMetric(ref.metric);
  if (spec && instrument && !spec.assetClasses.includes(instrument.assetClass)) {
    add(
      'error',
      'metric_unsupported',
      `${spec.label} can't be computed for ${instrument.symbol} (${instrument.assetClass})`,
      path,
      nodeId,
    );
  }
}

/** Fundamental metrics read company filings, which come from a company data feed (v1.2 item 6). */
function checkFundamentals(def: StrategyDefinition, ctx: ValidationContext, add: Add) {
  if (!usesFundamentals(def) || ctx.hasCompanyFeed) return;
  add(
    'error',
    'missing_company_feed',
    'Fundamental metrics read company filings: add an SEC EDGAR company data feed in Settings › Data feeds',
    ['entry'],
  );
}

// ---------------------------------------------------------------------------
// Selection groups and per-leg conditions (v1.2 items 1 and 2)
// ---------------------------------------------------------------------------

function checkSlots(def: StrategyDefinition, ctx: ValidationContext, add: Add) {
  const mode = slotModeOf(def);

  // Leg conditions only belong on Entry legs; Exit legs follow the Exit rules.
  def.exit.orders.forEach((o, i) => {
    if (o.legCondition)
      add(
        'error',
        'leg_condition_on_exit',
        `Exit leg "${o.legLabel}" can't have a leg condition; Exit legs follow the Exit rules`,
        ['exit', 'orders', i, 'legCondition'],
        o.id,
      );
  });

  if (mode === 'none') {
    for (const phase of ['entry', 'exit'] as const) {
      def[phase].orders.forEach((o, i) => {
        if (o.instrumentId === CONTEXT_INSTRUMENT_ID)
          add(
            'error',
            'context_instrument_misplaced',
            `"${o.legLabel}" trades "this instrument", which only a Selection group defines`,
            [phase, 'orders', i, 'instrumentId'],
            o.id,
          );
      });
    }
    return;
  }

  if (def.execution.reentry.mode !== 'single_cycle') {
    add(
      'error',
      'slots_need_single_cycle',
      mode === 'selection'
        ? 'A Selection group holds one position per selected instrument; set re-entry to "One cycle at a time"'
        : 'Per-leg conditions hold one position per leg; set re-entry to "One cycle at a time"',
      ['execution', 'reentry', 'mode'],
    );
  }
  if (def.execution.multiLegPolicy !== 'concurrent') {
    add(
      'error',
      'slots_need_concurrent',
      "Selection groups and per-leg conditions send each instrument's orders on their own; use concurrent submission",
      ['execution', 'multiLegPolicy'],
    );
  }
  // Each slot runs on its own, so legs can't time themselves off another leg.
  for (const phase of ['entry', 'exit'] as const) {
    def[phase].orders.forEach((o, i) => {
      const t = o.timing;
      if (
        t.mode === 'exact' ||
        (t.mode === 'relative' && t.reference.kind === 'leg') ||
        o.timingOnly
      ) {
        add(
          'error',
          'slots_timing',
          `"${o.legLabel}" must go immediately or after a phase event: with ${mode === 'selection' ? 'a Selection group' : 'per-leg conditions'} each instrument trades on its own`,
          [phase, 'orders', i, 'timing'],
          o.id,
        );
      }
    });
  }

  if (mode === 'selection') checkSelection(def, ctx, add);
  else checkLegConditions(def, ctx, add);
  const blocker = paperRunBlocker(def);
  if (blocker)
    add('warning', 'selection_backtest_only', blocker, ['entry', 'selection', 'universe']);
}

function checkSelection(def: StrategyDefinition, ctx: ValidationContext, add: Add) {
  const sel = def.entry.selection;
  if (!sel) {
    add('error', 'selection_missing', 'Set up the Selection group: universe, metric and count', [
      'entry',
      'selection',
    ]);
    return;
  }
  const template = def.entry.orders[0];
  if (def.entry.orders.length !== 1 || !template) {
    add(
      'error',
      'selection_one_leg',
      'A Selection group has exactly one Entry leg, which every selected instrument uses',
      ['entry', 'orders'],
    );
  } else if (template.instrumentId !== CONTEXT_INSTRUMENT_ID) {
    add(
      'error',
      'selection_leg_instrument',
      `"${template.legLabel}" must trade "each selected instrument", not a fixed one`,
      ['entry', 'orders', 0, 'instrumentId'],
      template.id,
    );
  }
  def.exit.orders.forEach((o, i) => {
    if (o.instrumentId !== CONTEXT_INSTRUMENT_ID)
      add(
        'error',
        'selection_exit_instrument',
        `Exit leg "${o.legLabel}" must close "each selected instrument"`,
        ['exit', 'orders', i, 'instrumentId'],
        o.id,
      );
  });

  // The metric must be one the registry computes for the universe's instruments.
  const members =
    sel.universe.type === 'list'
      ? sel.universe.instrumentIds.map((id) => ({ id, info: ctx.instruments.get(id) }))
      : [];
  const ranking = getMetric(sel.ranking.metric);
  for (const problem of checkMetricRef(sel.ranking))
    add('error', 'invalid_metric', problem, ['entry', 'selection', 'ranking']);
  for (const id of metricReferences(sel.ranking)) {
    if (!ctx.instruments.has(id))
      add('error', 'unknown_instrument', 'Choose a valid benchmark', [
        'entry',
        'selection',
        'ranking',
      ]);
  }
  const account = template ? ctx.accounts.get(template.accountId) : undefined;
  if (sel.universe.type === 'builtin') {
    if (ranking && !ranking.assetClasses.includes('stock')) {
      add('error', 'metric_unsupported', `${ranking.label} can't be computed for S&P 500 stocks`, [
        'entry',
        'selection',
        'ranking',
      ]);
    }
    if (!ctx.hasFeed('stock', 'bars')) {
      add('error', 'missing_feed', 'No active data feed covers US stock bars for the S&P 500', [
        'entry',
        'selection',
        'universe',
      ]);
    }
    if (account && !account.capabilities.assetClasses.includes('stock')) {
      add(
        'error',
        'unsupported_asset_class',
        `"${account.nickname}" can't trade stocks, so it can't hold S&P 500 members`,
        ['entry', 'selection', 'universe'],
      );
    }
  }
  const seen = new Set<string>();
  members.forEach(({ id, info }, i) => {
    const path = ['entry', 'selection', 'universe', 'instrumentIds', i];
    if (seen.has(id)) add('warning', 'universe_duplicate', 'This instrument is listed twice', path);
    seen.add(id);
    if (!info) {
      add('error', 'unknown_instrument', 'Choose a valid instrument for the universe', path);
      return;
    }
    if (isIndicatorOnlyClass(info.assetClass)) {
      add(
        'error',
        'instrument_not_tradable',
        `${info.symbol} is an index: it can be watched in conditions but not traded, so it can't be in a universe the strategy buys`,
        path,
      );
      return;
    }
    if (ranking && !ranking.assetClasses.includes(info.assetClass)) {
      add(
        'error',
        'metric_unsupported',
        `${ranking.label} can't be computed for ${info.symbol} (${info.assetClass})`,
        path,
      );
    }
    if (!ctx.hasFeed(info.assetClass, 'bars')) {
      add('error', 'missing_feed', `No active data feed covers ${info.symbol} bars`, path);
    }
    if (account) checkTradable(info, account, path, `${info.symbol} in the universe`, add);
  });
  if (
    sel.count.type === 'fixed' &&
    sel.universe.type === 'list' &&
    sel.count.value > members.length
  ) {
    add(
      'warning',
      'selection_count_above_universe',
      `The universe has ${members.length} instruments, fewer than the ${sel.count.value} to hold`,
      ['entry', 'selection', 'count', 'value'],
    );
  }
  if (sel.preFilter) checkTree(sel.preFilter, ['entry', 'selection', 'preFilter'], ctx, add, true);
}

/** Whether an account can trade an instrument, in the words of the leg checks. */
function checkTradable(
  info: InstrumentInfo,
  account: AccountInfo,
  path: (string | number)[],
  what: string,
  add: Add,
) {
  const caps = account.capabilities;
  if (!caps.assetClasses.includes(info.assetClass)) {
    add(
      'error',
      'unsupported_asset_class',
      `${what} can't be traded on "${account.nickname}" (it doesn't trade ${info.assetClass})`,
      path,
    );
  }
  if (info.venue && caps.coverage) {
    const demo = info.venue === DEMO_VENUE_CODE;
    if ((caps.coverage === 'demo') !== demo) {
      add('error', 'unsupported_venue', `${what} can't be traded on "${account.nickname}"`, path);
    }
  }
}

function checkLegConditions(def: StrategyDefinition, ctx: ValidationContext, add: Add) {
  const fire = def.entry.fireMode;
  if (fire?.mode === 'bestByMetric') {
    for (const problem of checkMetricRef(fire.metric))
      add('error', 'invalid_metric', problem, ['entry', 'fireMode', 'metric']);
    const spec = getMetric(fire.metric.metric);
    def.entry.orders.forEach((o, i) => {
      const info = ctx.instruments.get(o.instrumentId);
      if (spec && info && !spec.assetClasses.includes(info.assetClass))
        add(
          'error',
          'metric_unsupported',
          `${spec.label} can't be computed for ${info.symbol}, so "${o.legLabel}" can't be compared`,
          ['entry', 'orders', i, 'instrumentId'],
          o.id,
        );
    });
  }
  def.entry.orders.forEach((o, i) => {
    const path = ['entry', 'orders', i, 'legCondition'];
    if (!o.legCondition) return;
    if (!hasComparisons(o.legCondition)) {
      add(
        'error',
        'empty_leg_condition',
        `Add a condition to "${o.legLabel}" or remove its leg condition`,
        path,
        o.legCondition.id,
      );
    }
    checkTree(o.legCondition, path, ctx, add, true);
    // Instruments the leg condition reads must be tradable on the leg's account.
    const account = ctx.accounts.get(o.accountId);
    if (!account) return;
    const seen = new Set<string>();
    for (const e of walkExpressions(o.legCondition)) {
      if (!('instrumentId' in e) || e.instrumentId === CONTEXT_INSTRUMENT_ID) continue;
      if (seen.has(e.instrumentId)) continue;
      seen.add(e.instrumentId);
      const info = ctx.instruments.get(e.instrumentId);
      if (info)
        checkTradable(
          info,
          account,
          path,
          `${info.symbol} in the condition of "${o.legLabel}"`,
          add,
        );
    }
  });
  // Each leg that may fire on its own needs an Exit leg for its instrument.
  def.entry.orders.forEach((o, i) => {
    const covered = def.exit.orders.some(
      (x) => x.instrumentId === o.instrumentId || x.instrumentId === CONTEXT_INSTRUMENT_ID,
    );
    if (!covered)
      add(
        'error',
        'leg_without_exit',
        `Add an Exit leg for "${o.legLabel}": with per-leg conditions each leg is closed on its own`,
        ['entry', 'orders', i],
        o.id,
      );
  });
}

// ---------------------------------------------------------------------------
// Planned orders

function checkOrders(def: StrategyDefinition, phase: PhaseName, ctx: ValidationContext, add: Add) {
  const orders = def[phase].orders;
  const label = phase === 'entry' ? 'Entry' : 'Exit';
  if (orders.length === 0) {
    add('error', 'no_orders', `Add at least one ${label} order`, [phase, 'orders']);
  }
  if (orders.length > LIMITS.maxLegsPerPhase) {
    add('error', 'too_many_legs', `${label} has more than ${LIMITS.maxLegsPerPhase} legs`, [
      phase,
      'orders',
    ]);
  }

  const accountsUsed = new Set<string>();
  orders.forEach((o, i) => {
    const path = [phase, 'orders', i];
    const context = o.instrumentId === CONTEXT_INSTRUMENT_ID;
    const instrument = ctx.instruments.get(o.instrumentId);
    const account = ctx.accounts.get(o.accountId);
    if (!instrument && !context)
      add(
        'error',
        'unknown_instrument',
        `Choose a valid instrument for "${o.legLabel}"`,
        [...path, 'instrumentId'],
        o.id,
      );
    if (instrument && isIndicatorOnlyClass(instrument.assetClass)) {
      add(
        'error',
        'instrument_not_tradable',
        `${instrument.symbol} is an index: it can be watched in conditions but not traded, so it can't be the instrument of "${o.legLabel}"`,
        [...path, 'instrumentId'],
        o.id,
      );
    }
    if (!account) {
      add(
        'error',
        'missing_account',
        `Choose a trading account for "${o.legLabel}"`,
        [...path, 'accountId'],
        o.id,
      );
    } else {
      accountsUsed.add(o.accountId);
      checkAccountForLeg(o, path, account, instrument, def.execution.marketHoursPolicy, add);
    }

    if (phase === 'entry' && !OPENING_SIDES.includes(o.side)) {
      add(
        'error',
        'entry_side_not_opening',
        `Entry leg "${o.legLabel}" must open a position: use Buy or Sell short`,
        [...path, 'side'],
        o.id,
      );
    }

    checkQuantity(o, path, instrument, account, def, add);
    checkPrices(o, path, ctx, add);

    if (o.timing.mode === 'exact' && Date.parse(o.timing.at) <= ctx.now.getTime()) {
      add(
        'error',
        'exact_time_in_past',
        `The scheduled time for "${o.legLabel}" has already passed`,
        [...path, 'timing', 'at'],
        o.id,
      );
    }
    if (o.extendedHours) {
      add(
        'warning',
        'extended_hours',
        `"${o.legLabel}" may fill outside regular hours, when prices move more and liquidity is thinner`,
        [...path, 'extendedHours'],
        o.id,
      );
    }
  });

  if (orders.length > 1) {
    const atomic =
      [...accountsUsed].every((id) => ctx.accounts.get(id)?.capabilities.atomicMultiLeg) &&
      accountsUsed.size === 1;
    if (!atomic) {
      add(
        'warning',
        'non_atomic_multi_leg',
        `${label} legs are sent as separate orders. One can fill while another doesn't; the execution policy decides what happens then.`,
        [phase, 'orders'],
      );
    }
  }
}

/** The broker-level side an app side becomes when submitted. */
function brokerSides(side: OrderSide): string[] {
  return side === 'close' || side === 'reduce' ? ['buy', 'sell'] : [side];
}

function checkAccountForLeg(
  o: PlannedOrder,
  path: (string | number)[],
  account: AccountInfo,
  instrument: InstrumentInfo | undefined,
  marketHoursPolicy: StrategyDefinition['execution']['marketHoursPolicy'],
  add: Add,
) {
  try {
    assertAllowedTradingMode(account.mode);
  } catch {
    add(
      'error',
      'live_account_not_allowed',
      `"${account.nickname}" is not a paper account; this build trades on paper only`,
      [...path, 'accountId'],
      o.id,
    );
  }
  if (!account.isActive) {
    add(
      'error',
      'account_inactive',
      `"${account.nickname}" is disconnected or turned off`,
      [...path, 'accountId'],
      o.id,
    );
  }
  const caps = account.capabilities;
  // An index already has its own, clearer message (instrument_not_tradable).
  if (
    instrument &&
    !isIndicatorOnlyClass(instrument.assetClass) &&
    !caps.assetClasses.includes(instrument.assetClass)
  ) {
    add(
      'error',
      'unsupported_asset_class',
      `"${account.nickname}" can't trade ${instrument.assetClass}`,
      [...path, 'instrumentId'],
      o.id,
    );
  }
  if (instrument?.venue && caps.coverage) {
    const demoInstrument = instrument.venue === DEMO_VENUE_CODE;
    if ((caps.coverage === 'demo') !== demoInstrument) {
      add(
        'error',
        'unsupported_venue',
        caps.coverage === 'demo'
          ? `"${account.nickname}" trades the demo instruments only`
          : `"${account.nickname}" can't trade demo instruments`,
        [...path, 'instrumentId'],
        o.id,
      );
    }
  }
  if (!caps.orderTypes.includes(o.orderType)) {
    add(
      'error',
      'unsupported_order_type',
      `"${account.nickname}" doesn't support ${o.orderType.replace('_', '-')} orders`,
      [...path, 'orderType'],
      o.id,
    );
  }
  if (!caps.timeInForce.includes(o.timeInForce)) {
    add(
      'error',
      'unsupported_time_in_force',
      `"${account.nickname}" doesn't support time in force "${o.timeInForce}"`,
      [...path, 'timeInForce'],
      o.id,
    );
  }
  if (!brokerSides(o.side).every((s) => caps.sides.includes(s))) {
    add(
      'error',
      'unsupported_side',
      `"${account.nickname}" doesn't support this side`,
      [...path, 'side'],
      o.id,
    );
  }
  if (o.side === 'sell_short' && !caps.shortSelling) {
    add(
      'error',
      'short_selling_unsupported',
      `"${account.nickname}" doesn't allow short selling`,
      [...path, 'side'],
      o.id,
    );
  }
  if (o.extendedHours && !caps.extendedHours) {
    add(
      'error',
      'extended_hours_unsupported',
      `"${account.nickname}" doesn't support extended-hours orders`,
      [...path, 'extendedHours'],
      o.id,
    );
  }
  if (
    marketHoursPolicy === 'extended_if_supported' &&
    !o.extendedHours &&
    !extendedHoursEligible(o, caps.extendedHours)
  ) {
    add(
      'warning',
      'extended_hours_policy_waits',
      caps.extendedHours
        ? `"${o.legLabel}" waits for the regular session: only day limit orders can be sent in extended hours`
        : `"${o.legLabel}" waits for the regular session: "${account.nickname}" doesn't trade extended hours`,
      [...path, 'orderType'],
      o.id,
    );
  }
}

function checkQuantity(
  o: PlannedOrder,
  path: (string | number)[],
  instrument: InstrumentInfo | undefined,
  account: AccountInfo | undefined,
  def: StrategyDefinition,
  add: Add,
) {
  const q = new Decimal(o.quantity.value);
  const qPath = [...path, 'quantity', 'value'];
  switch (o.quantity.type) {
    case 'units':
      if (instrument && account && !account.capabilities.fractionalQuantity) {
        const lot = new Decimal(instrument.lotSize);
        if (!q.isInteger() || !q.mod(lot).isZero()) {
          add(
            'error',
            'invalid_quantity',
            `Quantity for "${o.legLabel}" must be a whole multiple of ${lot.toString()}`,
            qPath,
            o.id,
          );
        }
      }
      break;
    case 'pct_equity':
      if (q.gt(100))
        add(
          'error',
          'invalid_quantity',
          `"${o.legLabel}" can't use more than 100% of equity`,
          qPath,
          o.id,
        );
      break;
    case 'notional':
      if (def.risk.maxOrderNotional && q.gt(def.risk.maxOrderNotional)) {
        add(
          'error',
          'exceeds_max_order_notional',
          `"${o.legLabel}" is larger than the strategy's maximum order size of ${def.risk.maxOrderNotional}`,
          qPath,
          o.id,
        );
      }
      break;
    case 'risk_atr': {
      // v1.2 item 9: risk a percentage of equity with the stop a multiple of ATR away.
      const phase = path[path.length - 3] ?? path[0];
      if (phase === 'exit' && o.side !== 'close')
        add(
          'error',
          'risk_atr_entry_only',
          `"${o.legLabel}" closes a position: risk-based sizing is for Entry legs`,
          [...path, 'quantity', 'type'],
          o.id,
        );
      if (q.gt(100))
        add(
          'error',
          'invalid_quantity',
          `"${o.legLabel}" can't risk more than 100% of equity`,
          qPath,
          o.id,
        );
      if (!o.quantity.atrPeriod)
        add(
          'error',
          'risk_atr_needs_period',
          `Set the ATR period for "${o.legLabel}"`,
          [...path, 'quantity', 'atrPeriod'],
          o.id,
        );
      if (!o.quantity.atrMultiple)
        add(
          'error',
          'risk_atr_needs_multiple',
          `Set the stop distance in ATRs for "${o.legLabel}"`,
          [...path, 'quantity', 'atrMultiple'],
          o.id,
        );
      break;
    }
    case 'risk_sized':
      if (!o.stopPrice) {
        add(
          'error',
          'risk_sizing_needs_stop',
          `Risk-sized "${o.legLabel}" needs a stop price to size from`,
          [...path, 'stopPrice'],
          o.id,
        );
      }
      break;
  }
}

function checkPrices(o: PlannedOrder, path: (string | number)[], ctx: ValidationContext, add: Add) {
  const needsLimit = o.orderType === 'limit' || o.orderType === 'stop_limit';
  const needsStop = o.orderType === 'stop' || o.orderType === 'stop_limit';
  if (needsLimit && !o.limitPrice)
    add(
      'error',
      'missing_limit_price',
      `Set a limit price for "${o.legLabel}"`,
      [...path, 'limitPrice'],
      o.id,
    );
  if (needsStop && !o.stopPrice && o.quantity.type !== 'risk_sized') {
    add(
      'error',
      'missing_stop_price',
      `Set a stop price for "${o.legLabel}"`,
      [...path, 'stopPrice'],
      o.id,
    );
  }
  if (!needsLimit && o.limitPrice)
    add(
      'warning',
      'unused_limit_price',
      `The limit price on "${o.legLabel}" is ignored for ${o.orderType} orders`,
      [...path, 'limitPrice'],
      o.id,
    );
  const context = o.instrumentId === CONTEXT_INSTRUMENT_ID;
  if (o.limitPrice) checkExpr(o.limitPrice, [...path, 'limitPrice'], ctx, add, context);
  if (o.stopPrice) checkExpr(o.stopPrice, [...path, 'stopPrice'], ctx, add, context);
}

/**
 * Position values (entry price, gain, P&L) exist only after Entry fills, and
 * only for instruments an Entry leg trades.
 */
function checkPositionValues(def: StrategyDefinition, add: Add) {
  const traded = new Set(def.entry.orders.map((o) => o.instrumentId));
  // A slot's Exit rules may measure "this instrument", the slot's own position.
  if (slotModeOf(def) !== 'none') traded.add(CONTEXT_INSTRUMENT_ID);
  const sources: { phase: PhaseName; path: (string | number)[]; exprs: Expr[] }[] = [];
  for (const phase of ['entry', 'exit'] as const) {
    for (const c of walkComparisons(def[phase].condition)) {
      sources.push({
        phase,
        path: [phase, 'condition'],
        exprs: [c.left, c.right, c.upper].flatMap((e) => (e ? [...walkExpr(e)] : [])),
      });
    }
    def[phase].orders.forEach((o, i) => {
      for (const key of ['limitPrice', 'stopPrice'] as const) {
        const e = o[key];
        if (e) sources.push({ phase, path: [phase, 'orders', i, key], exprs: [...walkExpr(e)] });
      }
    });
  }
  for (const { phase, path, exprs } of sources) {
    for (const e of exprs) {
      if (e.kind !== 'position') continue;
      if (phase === 'entry') {
        add(
          'error',
          'position_in_entry',
          'Position values only exist after Entry fills; use them in Exit rules',
          path,
          e.id,
        );
      } else if (!traded.has(e.instrumentId)) {
        add(
          'error',
          'position_not_traded',
          'No Entry leg trades this instrument, so there is no position to measure',
          path,
          e.id,
        );
      }
    }
  }
}

/**
 * An Exit order must reduce what Entry opened. Anything that could open or
 * flip a position when "close" was intended blocks activation (§6.10).
 */
function checkExitExposure(def: StrategyDefinition, add: Add) {
  const opened = new Map<string, { side: OrderSide; units?: Decimal }[]>();
  for (const o of def.entry.orders) {
    const list = opened.get(o.instrumentId) ?? [];
    list.push({
      side: o.side,
      ...(o.quantity.type === 'units' ? { units: new Decimal(o.quantity.value) } : {}),
    });
    opened.set(o.instrumentId, list);
  }

  def.exit.orders.forEach((o, i) => {
    const path = ['exit', 'orders', i, 'side'];
    const entries = opened.get(o.instrumentId) ?? [];
    const longs = entries.filter((e) => e.side === 'buy');
    const shorts = entries.filter((e) => e.side === 'sell_short');

    if (o.side === 'buy' || o.side === 'sell_short') {
      add(
        'error',
        'exit_opens_position',
        `Exit leg "${o.legLabel}" would open a new position. Use Close, Reduce, Sell or Buy to cover.`,
        path,
        o.id,
      );
      return;
    }
    if (entries.length === 0) {
      add(
        'error',
        'exit_without_entry',
        `Exit leg "${o.legLabel}" closes an instrument the Entry plan never opens`,
        ['exit', 'orders', i, 'instrumentId'],
        o.id,
      );
      return;
    }
    if (o.side === 'sell' && longs.length === 0) {
      add(
        'error',
        'exit_sell_without_long',
        `Exit leg "${o.legLabel}" sells without a long Entry position and would open a short. Use Buy to cover or Close.`,
        path,
        o.id,
      );
    }
    if (o.side === 'buy_to_cover' && shorts.length === 0) {
      add(
        'error',
        'exit_cover_without_short',
        `Exit leg "${o.legLabel}" buys to cover, but Entry never sells short this instrument`,
        path,
        o.id,
      );
    }
    // When both sides are fixed share counts, the exit can't exceed what was opened.
    if (
      o.quantity.type === 'units' &&
      (o.side === 'sell' || o.side === 'buy_to_cover' || o.side === 'reduce')
    ) {
      const relevant = o.side === 'sell' ? longs : o.side === 'buy_to_cover' ? shorts : entries;
      if (relevant.length > 0 && relevant.every((e) => e.units)) {
        const total = relevant.reduce((sum, e) => sum.plus(e.units as Decimal), new Decimal(0));
        if (new Decimal(o.quantity.value).gt(total)) {
          add(
            'error',
            'exit_exceeds_position',
            `Exit leg "${o.legLabel}" is larger than the ${total.toString()} units Entry opens and would flip the position`,
            ['exit', 'orders', i, 'quantity', 'value'],
            o.id,
          );
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------

function checkExecution(def: StrategyDefinition, add: Add) {
  const ex = def.execution;
  if (ex.multiLegPolicy !== 'concurrent') {
    const legIds = [...def.entry.orders, ...def.exit.orders].map((o) => o.id);
    const order = ex.legOrder ?? [];
    const missing = legIds.filter((id) => !order.includes(id));
    const unknown = order.filter((id) => !legIds.includes(id));
    if (missing.length > 0 || unknown.length > 0 || new Set(order).size !== order.length) {
      add(
        'error',
        'invalid_leg_order',
        'Sequential submission needs every leg listed once in submission order',
        ['execution', 'legOrder'],
      );
    }
  }
  if (ex.reentry.mode === 'pyramid' && ex.reentry.cap === undefined) {
    add('error', 'pyramid_needs_cap', 'Set a maximum number of entries for pyramiding', [
      'execution',
      'reentry',
      'cap',
    ]);
  }
}

function checkRisk(def: StrategyDefinition, _ctx: ValidationContext, add: Add) {
  for (const key of REQUIRED_RISK_LIMITS) {
    if (def.risk[key] === undefined) {
      add('error', 'missing_risk_limit', `Set the ${RISK_LABELS[key]} risk limit`, ['risk', key]);
    }
  }
  const { maxOrderNotional, maxStrategyExposure } = def.risk;
  if (
    maxOrderNotional &&
    maxStrategyExposure &&
    new Decimal(maxOrderNotional).gt(maxStrategyExposure)
  ) {
    add(
      'warning',
      'order_limit_above_exposure',
      'The maximum order size is larger than the maximum strategy exposure',
      ['risk', 'maxOrderNotional'],
    );
  }
}

export const RISK_LABELS: Record<(typeof REQUIRED_RISK_LIMITS)[number], string> = {
  maxOrderNotional: 'maximum order size',
  maxStrategyExposure: 'maximum strategy exposure',
  maxActiveOrders: 'maximum active orders',
  dailyLossLimit: 'daily loss',
  priceCollarPct: 'price collar',
};

function checkBacktest(ctx: ValidationContext, add: Add) {
  if (ctx.backtest === undefined) return; // back testing arrives in Phase 2
  if (ctx.backtest === null) {
    add('warning', 'no_backtest', 'This strategy has not been back tested', []);
  } else if (ctx.definitionHash && ctx.backtest.definitionHash !== ctx.definitionHash) {
    add('warning', 'stale_backtest', 'The strategy changed after its latest back test', []);
  }
}
