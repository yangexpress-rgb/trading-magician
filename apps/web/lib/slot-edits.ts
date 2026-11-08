import {
  CONTEXT_INSTRUMENT_ID,
  DEFAULT_TRIGGER,
  getMetric,
  randomId,
  refillExitOrders,
  resolveMetricParams,
  type ExitRule,
  type PlannedOrder,
  type Selection,
  type StrategyDefinition,
} from '@tm/domain';

/**
 * Builder edits that switch a strategy between fixed legs and a Selection
 * group (v1.2 item 1), and the default rules each needs. They only shape the
 * definition; validation explains anything left to fix.
 */

/** Notional dollars the template leg buys, split equally across the selections. */
export const DEFAULT_SELECTION_NOTIONAL = '9000';

export function defaultSelection(instrumentIds: readonly string[]): Selection {
  const spec = getMetric('return');
  return {
    universe:
      instrumentIds.length > 0
        ? { type: 'list', instrumentIds: [...instrumentIds] }
        : { type: 'builtin', id: 'sp500' },
    ranking: { metric: 'return', params: spec ? resolveMetricParams(spec, {}) : {} },
    direction: 'desc',
    count: { type: 'fixed', value: Math.min(3, Math.max(1, instrumentIds.length || 3)) },
  };
}

/**
 * Enter only the best of the Entry legs by a metric (ADR 0049): a Selection
 * group whose universe is these legs, top 1. Each leg's own conditions are
 * its pre-filter; the legs, their instruments and their Exit stay as they are.
 */
export function toLegsSelection(def: StrategyDefinition): StrategyDefinition {
  const spec = getMetric('return');
  const { trigger: _t, ...exit } = def.exit;
  void _t;
  return {
    ...def,
    entry: {
      ...def.entry,
      kind: 'selection',
      selection: {
        universe: { type: 'legs' },
        ranking: { metric: 'return', params: spec ? resolveMetricParams(spec, {}) : {} },
        direction: 'desc',
        count: { type: 'fixed', value: 1 },
      },
    },
    exit,
  };
}

/** Enter every leg that qualifies: back to plain fixed legs, keeping each leg's conditions. */
export function fromLegsSelection(def: StrategyDefinition): StrategyDefinition {
  const { kind: _k, selection: _s, ...entry } = def.entry;
  void _k;
  void _s;
  return {
    ...def,
    entry,
    exit: { ...def.exit, trigger: def.exit.trigger ?? { ...DEFAULT_TRIGGER } },
  };
}

/**
 * Turn Entry into a Selection group: one template leg trading "each selected
 * instrument", Exit legs that close it, one cycle per instrument, concurrent
 * submission, and a month-end schedule unless one was already chosen.
 */
export function toSelectionGroup(
  def: StrategyDefinition,
  instrumentIds: readonly string[],
  accountId = '',
): StrategyDefinition {
  const first = def.entry.orders[0];
  const quantity: PlannedOrder['quantity'] =
    first && first.quantity.type !== 'units'
      ? first.quantity
      : { type: 'notional', value: DEFAULT_SELECTION_NOTIONAL, rounding: 'down' };
  const template: PlannedOrder = {
    ...(first ?? {
      id: randomId(),
      legLabel: 'Buy each selected',
      accountId,
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
    }),
    instrumentId: CONTEXT_INSTRUMENT_ID,
    quantity,
    timing: { mode: 'immediate' },
  } as PlannedOrder;
  const { legCondition: _lc, ...leg } = template;
  void _lc;
  const { trigger: _t, ...exit } = def.exit;
  void _t;
  const kept = def.entry.selection;
  const next: StrategyDefinition = {
    ...def,
    entry: {
      ...def.entry,
      kind: 'selection',
      selection: kept && kept.universe.type !== 'legs' ? kept : defaultSelection(instrumentIds),
      orders: [leg],
    },
    // A Selection group has no Exit trigger: its Exit condition exits directly (ADR 0049).
    exit: { ...exit, mirrorEntry: true },
    execution: {
      ...def.execution,
      multiLegPolicy: 'concurrent',
      reentry: { mode: 'single_cycle' },
      legOrder: undefined,
    },
    schedule: def.schedule ?? { frequency: 'monthEnd' },
  };
  return refillExitOrders(next);
}

/** Back to fixed legs: the template leg trades `instrumentId` and Exit follows it. */
export function toFixedLegs(def: StrategyDefinition, instrumentId: string): StrategyDefinition {
  const { kind: _k, selection: _s, ...entry } = def.entry;
  void _k;
  void _s;
  const bind = (o: PlannedOrder): PlannedOrder =>
    o.instrumentId === CONTEXT_INSTRUMENT_ID ? { ...o, instrumentId } : o;
  return refillExitOrders({
    ...def,
    entry: { ...entry, orders: def.entry.orders.map(bind) },
    exit: { ...def.exit, trigger: def.exit.trigger ?? { ...DEFAULT_TRIGGER }, mirrorEntry: true },
  });
}

export function timeStopRule(barsHeld = 5): ExitRule {
  return { kind: 'timeStop', id: randomId(), barsHeld };
}

/** A fixed stop at the Entry's risk distance from the entry price (ADR 0049). */
export function atrStopRule(): ExitRule {
  return { kind: 'atrStop', id: randomId() };
}

/**
 * Exit beyond the expected move at entry (ADR 0053): one 5-day expected move,
 * either way, until the person changes it.
 */
export function expectedMoveRule(): ExitRule {
  return { kind: 'expectedMove', id: randomId(), horizon: 5, multiple: '1', side: 'either' };
}

/** A trailing stop 5% below the best close since entry (ADR 0059), until the person changes it. */
export function trailingStopRule(percent = '5'): ExitRule {
  return { kind: 'trailingStop', id: randomId(), percent };
}

/** The risk distance a new Entry starts with: 2 × ATR(20) (v1.2 item 9). */
export const DEFAULT_RISK_DISTANCE = { atrPeriod: 20, atrMultiple: '2' } as const;
