import Decimal from 'decimal.js';
import { markExpr } from './evaluate';
import { createDefinition } from './defaults';
import {
  isStateDays,
  walkMachineConditions,
  type MachineDefinition,
  type MachineRisk,
  type MachineState,
} from './machine-schema';
import { metricExprRef, metricRequirements } from './metrics';
import type { Expr, IndicatorExpr, MarketExpr, RiskProfile, StrategyDefinition } from './schema';
import type { InstrumentUse } from './tree';

/**
 * What a state machine reads and holds (state-machine brief v1.4 §2.3, §2.5;
 * ADR 0124 P2b), and the rebalancing arithmetic shared by the back test and
 * the paper runtime.
 */

type SeriesNeed = MarketExpr | IndicatorExpr;

/** Every series the rows read, with what metrics and statistics read further back. */
export function machineSeries(def: MachineDefinition): SeriesNeed[] {
  const out: SeriesNeed[] = [];
  const visit = (e: Expr, extra: number) => {
    switch (e.kind) {
      case 'constant':
        return;
      case 'market':
      case 'indicator':
        out.push({ ...e, offset: e.offset + extra });
        return;
      case 'position':
        out.push(markExpr(e));
        return;
      case 'metric':
        for (const s of metricRequirements(metricExprRef(e), e.instrumentId))
          out.push({ ...s, offset: s.offset + extra + (e.offset ?? 0) });
        return;
      case 'stat':
        visit(e.input, extra + e.period - 1 + (e.offset ?? 0));
        return;
      case 'calc':
        for (const a of e.args) visit(a, extra);
        return;
    }
  };
  for (const row of def.machine.rows)
    if (row.condition)
      for (const n of walkMachineConditions(row.condition))
        if (n.kind === 'comparison')
          for (const side of [n.left, n.right, n.upper])
            if (side && !isStateDays(side)) visit(side as Expr, 0);
  return out;
}

/** The instruments the states hold, in the order they first appear. */
export function machineTargets(def: MachineDefinition): string[] {
  const ids = new Set<string>();
  for (const s of def.machine.states) for (const t of s.targets) ids.add(t.instrumentId);
  return [...ids];
}

/** The signal context plus every target (§2.5). */
export function machineInstruments(def: MachineDefinition): string[] {
  return [...new Set([...def.trade.instrumentIds, ...machineTargets(def)])];
}

/** Fixed no-trade bands of v1 (§2.3), as fractions of equity. */
export const LEG_BAND = new Decimal('0.005');
export const SWITCH_BAND = new Decimal('0.05');

export interface RebalanceLeg {
  instrumentId: string;
  /** Target value − current value, at the given prices; negative sells. */
  difference: Decimal;
  /** The difference as a fraction of equity. */
  fraction: Decimal;
  /** Whole lots to trade: positive buys, negative sells; 0 when under the leg band. */
  quantity: Decimal;
}

export interface RebalancePlan {
  equity: Decimal;
  legs: RebalanceLeg[];
  /**
   * Every leg is under the 0.5% band, or too small for one whole lot: the
   * transition is done (§2.4), as nothing is left to trade.
   */
  done: boolean;
  /** Every leg is under the 5% band: a new state switches with no orders (§2.3). */
  underSwitchBand: boolean;
}

/**
 * The legs that move holdings to a state's target weights (§2.3): per
 * instrument held or targeted, target value − current value at these prices,
 * as a fraction of equity. Sells to a zero target sell everything; otherwise
 * whole lots, rounded toward the smaller trade so a buy never overshoots.
 */
export function planRebalance(
  state: Pick<MachineState, 'targets'>,
  holdings: ReadonlyMap<string, Decimal>,
  cash: Decimal,
  price: (instrumentId: string) => Decimal | undefined,
  lot: (instrumentId: string) => Decimal = () => new Decimal(1),
): RebalancePlan | undefined {
  const ids = new Set<string>([
    ...[...holdings].filter(([, q]) => !q.isZero()).map(([id]) => id),
    ...state.targets.map((t) => t.instrumentId),
  ]);
  let equity = cash;
  for (const id of ids) {
    const q = holdings.get(id);
    if (!q || q.isZero()) continue;
    const p = price(id);
    if (!p) return undefined;
    equity = equity.plus(q.times(p));
  }
  if (!equity.gt(0)) return undefined;
  const weight = new Map(
    state.targets.map((t) => [t.instrumentId, new Decimal(t.weightPct).div(100)]),
  );
  const legs: RebalanceLeg[] = [];
  for (const id of ids) {
    const p = price(id);
    if (!p || !p.gt(0)) return undefined;
    const held = holdings.get(id) ?? new Decimal(0);
    const target = equity.times(weight.get(id) ?? 0);
    const difference = target.minus(held.times(p));
    const fraction = difference.div(equity);
    const size = lot(id);
    let quantity = new Decimal(0);
    if (fraction.abs().gte(LEG_BAND)) {
      if (!weight.get(id)?.gt(0)) quantity = held.negated();
      else {
        const lots = difference.abs().div(p.times(size)).floor().times(size);
        quantity = difference.isNegative() ? Decimal.min(lots, held).negated() : lots;
      }
    }
    legs.push({ instrumentId: id, difference, fraction, quantity });
  }
  return {
    equity,
    legs,
    done: legs.every((l) => l.quantity.isZero()),
    underSwitchBand: legs.every((l) => l.fraction.abs().lt(SWITCH_BAND)),
  };
}

/**
 * Every instrument a state machine reads or holds, for the strategy's
 * instrument index (as `collectInstrumentUses` does for the rules form): the
 * rows' reads as Entry conditions, the targets as orders.
 */
export function machineInstrumentUses(def: MachineDefinition): InstrumentUse[] {
  const uses: InstrumentUse[] = [];
  for (const s of machineSeries(def))
    uses.push({ instrumentId: s.instrumentId, phase: 'entry', role: 'condition' });
  for (const id of def.trade.instrumentIds)
    uses.push({ instrumentId: id, phase: 'entry', role: 'condition' });
  for (const id of machineTargets(def))
    uses.push({ instrumentId: id, phase: 'entry', role: 'order' });
  return uses;
}

/**
 * The run-level plumbing a paper run shares with the rules form (feed
 * watching, the order-time price collar, market-hours handling) reads a
 * rules-shaped definition. A state-machine run hands it this carrier: the
 * machine's own execution and collar, no conditions and no legs, so nothing
 * of the rules form can ever plan an order for it (ADR 0124 P3a).
 */
export function machineCarrier(def: MachineDefinition): StrategyDefinition {
  const base = createDefinition(() => 'machine');
  return {
    ...base,
    execution: {
      ...base.execution,
      multiLegPolicy: 'after_prior_fill',
      legTimeoutSec: def.execution.legTimeoutSec,
      onLegFailure: def.execution.onLegFailure,
      marketHoursPolicy: def.execution.marketHoursPolicy,
      holidayCalendar: def.execution.holidayCalendar,
      staleDataSec: def.execution.staleDataSec,
    },
    risk: {
      ...(def.risk.priceCollarPct ? { priceCollarPct: def.risk.priceCollarPct } : {}),
      ...(def.risk.maxActiveOrders ? { maxActiveOrders: def.risk.maxActiveOrders } : {}),
    },
  };
}

/**
 * This form's limits (§2.8) as the pre-trade check reads them, at this
 * equity: the % of equity limits become dollars now, so they scale as equity
 * grows; there is never a strategy trailing stop.
 */
export function machineRiskProfile(risk: MachineRisk, equity: Decimal): RiskProfile {
  const pct = (p: string | undefined) =>
    p && equity.gt(0) ? equity.times(p).div(100).toDecimalPlaces(2).toString() : undefined;
  const order = pct(risk.maxOrderPctEquity);
  const strategy = pct(risk.maxStrategyPctEquity);
  return {
    ...(order ? { maxOrderNotional: order } : {}),
    ...(strategy ? { maxStrategyExposure: strategy } : {}),
    ...(risk.maxActiveOrders ? { maxActiveOrders: risk.maxActiveOrders } : {}),
    ...(risk.dailyLossLimit ? { dailyLossLimit: risk.dailyLossLimit } : {}),
    ...(risk.priceCollarPct ? { priceCollarPct: risk.priceCollarPct } : {}),
    ...(risk.maxDrawdownPct ? { maxDrawdownPct: risk.maxDrawdownPct } : {}),
  };
}
