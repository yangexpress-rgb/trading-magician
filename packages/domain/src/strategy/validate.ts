import Decimal from 'decimal.js';
import { assertAllowedTradingMode } from '../trading-mode';
import { DEMO_VENUE_CODE } from '../integrations/providers';
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
import { checkTiming } from './timing';
import { exprDepth, treeDepth, walkComparisons, walkExpr } from './tree';

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
  checkExitExposure(def, add);
  checkPositionValues(def, add);
  checkExecution(def, add);
  checkRisk(def, ctx, add);

  for (const p of checkTiming(def)) {
    const index = def[p.phase].orders.findIndex((o) => o.id === p.legId);
    add('error', p.code, p.message, [p.phase, 'orders', index, 'timing'], p.legId);
  }

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
  for (const phase of ['entry', 'exit'] as const) {
    visitNode(def[phase].condition);
    def[phase].orders.forEach((o, i) => {
      if (seen.has(o.id))
        add(
          'error',
          'duplicate_id',
          'The definition has duplicate ids',
          [phase, 'orders', i],
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
          [phase, 'orders', i, 'legLabel'],
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
    if (!allTimingOnly) {
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

  const visitGroup = (g: ConditionGroup, path: (string | number)[]) => {
    if (g !== root && g.children.length === 0) {
      add('error', 'empty_group', 'This group is empty; add a condition or remove it', path, g.id);
    }
    g.children.forEach((c, i) => {
      const childPath = [...path, 'children', i];
      if (c.kind === 'group') visitGroup(c, childPath);
      else checkComparison(c, childPath, ctx, add);
    });
  };
  visitGroup(root, [phase, 'condition']);
}

function isSeries(e: Expr): boolean {
  return e.kind === 'market' || e.kind === 'indicator' || e.kind === 'position';
}

function containsSeries(e: Expr): boolean {
  for (const x of walkExpr(e)) if (isSeries(x)) return true;
  return false;
}

function checkComparison(
  c: Comparison,
  path: (string | number)[],
  ctx: ValidationContext,
  add: Add,
) {
  const sides: [Expr | undefined, string][] = [
    [c.left, 'left'],
    [c.right, 'right'],
    [c.upper, 'upper'],
  ];
  for (const [expr, key] of sides) if (expr) checkExpr(expr, [...path, key], ctx, add);

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

function checkExpr(expr: Expr, path: (string | number)[], ctx: ValidationContext, add: Add) {
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

    const instrument = ctx.instruments.get(e.instrumentId);
    if (!instrument) {
      add('error', 'unknown_instrument', 'Choose a valid instrument', [...p, 'instrumentId'], e.id);
    } else {
      const dataType = e.kind === 'market' && QUOTE_FIELDS.includes(e.field) ? 'quotes' : 'bars';
      if (!ctx.hasFeed(instrument.assetClass, dataType)) {
        add(
          'error',
          'missing_feed',
          `No active data feed covers ${instrument.symbol} ${dataType}`,
          [...p, 'instrumentId'],
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
    const instrument = ctx.instruments.get(o.instrumentId);
    const account = ctx.accounts.get(o.accountId);
    if (!instrument)
      add(
        'error',
        'unknown_instrument',
        `Choose a valid instrument for "${o.legLabel}"`,
        [...path, 'instrumentId'],
        o.id,
      );
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
      checkAccountForLeg(o, path, account, instrument, add);
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
  if (instrument && !caps.assetClasses.includes(instrument.assetClass)) {
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
  if (o.limitPrice) checkExpr(o.limitPrice, [...path, 'limitPrice'], ctx, add);
  if (o.stopPrice) checkExpr(o.stopPrice, [...path, 'stopPrice'], ctx, add);
}

/**
 * Position values (entry price, gain, P&L) exist only after Entry fills, and
 * only for instruments an Entry leg trades.
 */
function checkPositionValues(def: StrategyDefinition, add: Add) {
  const traded = new Set(def.entry.orders.map((o) => o.instrumentId));
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
