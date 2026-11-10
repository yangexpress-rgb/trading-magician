import {
  CONTEXT_INSTRUMENT_ID,
  DEFAULT_TRIGGER,
  getMetric,
  randomId,
  refillExitOrders,
  resolveMetricParams,
  suggestedExitSchedule,
  type ExitRule,
  type PlannedOrder,
  type StrategyDefinition,
  type Trade,
} from '@tm/domain';

/**
 * Builder edits for What to trade (ADR 0073): specific assets or a group, and
 * the defaults each needs. They only shape the definition; validation
 * explains anything left to fix.
 */

/** Dollars each pick buys in a new group (the amount is per pick, ADR 0073). */
export const DEFAULT_PICK_NOTIONAL = '3000';
/** Dollars a new asset's Entry leg buys. */
export const DEFAULT_ASSET_NOTIONAL = '1000';

type GroupTrade = Extract<Trade, { kind: 'group' }>;

export function defaultGroup(instrumentIds: readonly string[]): GroupTrade {
  return {
    kind: 'group',
    universe:
      instrumentIds.length > 0
        ? { type: 'list', instrumentIds: [...instrumentIds] }
        : { type: 'builtin', id: 'sp500' },
    ranking: defaultRanking(instrumentIds.length || 3),
  };
}

/** Rank by 1-month return, highest first, top 3 (fewer for a short list). */
export function defaultRanking(members = 3): NonNullable<GroupTrade['ranking']> {
  const spec = getMetric('return');
  return {
    metric: 'return',
    params: spec ? resolveMetricParams(spec, {}) : {},
    direction: 'desc',
    count: { type: 'fixed', value: Math.min(3, Math.max(1, members)) },
  };
}

/** The specific assets a strategy trades: its Entry legs' instruments, in order. */
export function tradedAssets(def: StrategyDefinition): string[] {
  const ids: string[] = [];
  for (const p of [def, ...(def.groups ?? [])])
    for (const o of p.entry.orders)
      if (
        o.instrumentId &&
        o.instrumentId !== CONTEXT_INSTRUMENT_ID &&
        !ids.includes(o.instrumentId)
      )
        ids.push(o.instrumentId);
  return ids;
}

/**
 * Swap one asset for another everywhere it is named: legs, conditions and
 * order prices, so changing the stock in What to trade changes the strategy.
 */
export function replaceAsset(
  def: StrategyDefinition,
  from: string,
  to: string,
): StrategyDefinition {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        k === 'instrumentId' && x === from ? to : walk(x),
      ]),
    );
  };
  return walk(def) as StrategyDefinition;
}

/** Add an asset: an Entry leg that buys it, like the first leg if there is one. */
export function addAsset(
  def: StrategyDefinition,
  instrumentId: string,
  accountId = '',
): StrategyDefinition {
  const first = def.entry.orders[0];
  const taken = new Set(def.entry.orders.map((o) => o.legLabel.toLowerCase()));
  let n = def.entry.orders.length + 1;
  while (taken.has(`buy ${n}`)) n += 1;
  const leg: PlannedOrder = {
    id: randomId(),
    legLabel: first ? `Buy ${n}` : 'Buy',
    instrumentId,
    accountId: first?.accountId ?? accountId,
    side: first?.side ?? 'buy',
    quantity: first
      ? { ...first.quantity }
      : { type: 'notional', value: DEFAULT_ASSET_NOTIONAL, rounding: 'down' },
    orderType: 'market',
    timeInForce: 'day',
    timing: { mode: 'immediate' },
  };
  const next: StrategyDefinition = {
    ...def,
    entry: { ...def.entry, orders: [...def.entry.orders, leg] },
  };
  return next.exit.mirrorEntry ? refillExitOrders(next) : next;
}

/** Remove an asset: its Entry legs, and its Exit legs when they mirror Entry. */
export function removeAsset(def: StrategyDefinition, instrumentId: string): StrategyDefinition {
  const next: StrategyDefinition = {
    ...def,
    entry: {
      ...def.entry,
      orders: def.entry.orders.filter((o) => o.instrumentId !== instrumentId),
    },
  };
  return next.exit.mirrorEntry
    ? refillExitOrders(next)
    : {
        ...next,
        exit: {
          ...next.exit,
          orders: next.exit.orders.filter((o) => o.instrumentId !== instrumentId),
        },
      };
}

/** Enter every leg that qualifies: drop schema 2's ranked legs, keeping each leg's conditions. */
export function fromLegsSelection(def: StrategyDefinition): StrategyDefinition {
  const { rankedLegs: _r, ...entry } = def.entry;
  void _r;
  return {
    ...def,
    entry,
    exit: { ...def.exit, trigger: def.exit.trigger ?? { ...DEFAULT_TRIGGER } },
  };
}

/**
 * What to trade becomes a group: one leg trading "each pick" (an amount per
 * pick), Exit legs that close it, "Left the group" on, one cycle per pick,
 * concurrent submission, Check Entry at month end unless one was chosen and
 * Check Exit once a day (O145).
 */
export function toGroup(
  def: StrategyDefinition,
  instrumentIds: readonly string[],
  accountId = '',
): StrategyDefinition {
  const first = def.entry.orders[0];
  const quantity: PlannedOrder['quantity'] =
    first && first.quantity.type !== 'units'
      ? first.quantity
      : { type: 'notional', value: DEFAULT_PICK_NOTIONAL, rounding: 'down' };
  const template: PlannedOrder = {
    ...(first ?? {
      id: randomId(),
      accountId,
      side: 'buy',
      orderType: 'market',
      timeInForce: 'day',
    }),
    legLabel: 'Buy each pick',
    instrumentId: CONTEXT_INSTRUMENT_ID,
    quantity,
    timing: { mode: 'immediate' },
  } as PlannedOrder;
  const { legCondition: _lc, ...leg } = template;
  void _lc;
  const { trigger: _t, ...exit } = def.exit;
  void _t;
  const { rankedLegs: _r, ...entry } = def.entry;
  void _r;
  const schedule = entry.schedule ?? { frequency: 'monthEnd' as const };
  const rules = exit.rules ?? [];
  const next: StrategyDefinition = {
    ...def,
    trade: defaultGroup(instrumentIds),
    entry: { ...entry, schedule, orders: [leg] },
    // A group has no Exit trigger: its Exit condition exits directly (ADR 0049).
    exit: {
      ...exit,
      mirrorEntry: true,
      schedule: exit.schedule ?? { frequency: suggestedExitSchedule(schedule.frequency) },
      rules: rules.some((r) => r.kind === 'leftGroup') ? rules : [...rules, leftGroupRule()],
    },
    execution: {
      ...def.execution,
      multiLegPolicy: 'concurrent',
      reentry: { mode: 'single_cycle' },
      legOrder: undefined,
    },
  };
  return refillExitOrders(next);
}

/** Back to specific assets: the template leg trades `instrumentId` and Exit follows it. */
export function toAssets(def: StrategyDefinition, instrumentId: string): StrategyDefinition {
  const bind = (o: PlannedOrder): PlannedOrder =>
    o.instrumentId === CONTEXT_INSTRUMENT_ID ? { ...o, instrumentId, legLabel: 'Buy' } : o;
  const rules = (def.exit.rules ?? []).filter((r) => r.kind !== 'leftGroup');
  const { rules: _r, ...exit } = def.exit;
  void _r;
  return refillExitOrders({
    ...def,
    trade: { kind: 'assets' },
    entry: { ...def.entry, orders: def.entry.orders.map(bind) },
    exit: {
      ...exit,
      ...(rules.length > 0 ? { rules } : {}),
      trigger: def.exit.trigger ?? { ...DEFAULT_TRIGGER },
      mirrorEntry: true,
    },
  });
}

/** Sell a holding at an Entry check once it no longer passes the filter or ranking (ADR 0073). */
export function leftGroupRule(): ExitRule {
  return { kind: 'leftGroup', id: randomId() };
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
