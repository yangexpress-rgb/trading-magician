import {
  CONTEXT_INSTRUMENT_ID,
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
    weighting: 'equal',
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
      extendedHours: false,
      timingOnly: false,
    }),
    instrumentId: CONTEXT_INSTRUMENT_ID,
    quantity,
    timing: { mode: 'immediate' },
  } as PlannedOrder;
  const { legCondition: _lc, ...leg } = template;
  void _lc;
  const { fireMode: _fm, ...entry } = def.entry;
  void _fm;
  const next: StrategyDefinition = {
    ...def,
    entry: {
      ...entry,
      kind: 'selection',
      selection: def.entry.selection ?? defaultSelection(instrumentIds),
      orders: [leg],
    },
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
  return refillExitOrders({ ...def, entry: { ...entry, orders: def.entry.orders.map(bind) } });
}

export function timeStopRule(barsHeld = 5): ExitRule {
  return { kind: 'timeStop', id: randomId(), barsHeld };
}
