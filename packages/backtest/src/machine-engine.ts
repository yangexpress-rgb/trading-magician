import {
  decideDay,
  fallbackStateId,
  machineInstruments,
  machineSeries,
  machineView,
  nyDate,
  planRebalance,
  type DayDecision,
  type MachineDefinition,
  type MachineRow,
  type MachineView,
  type MarketExpr,
  type RebalancePlan,
  type StateSwitch,
} from '@tm/domain';
import Decimal from 'decimal.js';
import {
  planExprs,
  seriesKey,
  watchOnlyInstruments,
  type InstrumentRef,
  type LoadedData,
  type SeriesPlan,
} from './data';
import { quoteFill, volumeCap } from './fills';
import { machineConditionChecks } from './explain';
import { describeAssumptions, type BacktestInputs } from './inputs';
import { MarketView } from './market';
import { computeMetrics } from './metrics';
import {
  SHARPE_METHOD,
  type BacktestFill,
  type BacktestOrder,
  type BacktestResult,
  type ConditionCheck,
  type EquityPoint,
  type InstrumentContribution,
  type MachineRunReport,
  type MachineTransitionRecord,
  type StateStay,
} from './results';

/**
 * The state-machine back test (state-machine brief v1.4 §2.3–§2.7, ADR 0124
 * P2b). Each daily close decides the day with the shared evaluator; a switch
 * rebalances to the new state's target weights at the next open, sells first
 * and buys from the cash they leave (`after_prior_fill`), with the fixed
 * no-trade bands. A transition that does not finish is completed on the
 * following closes for up to 5 trading days, then marked stuck; a newer
 * transition supersedes it. Before the run's first day the state path is
 * replayed over every loaded bar with no orders, as Start does on paper (§2.9).
 */

export const MACHINE_ENGINE_VERSION = 'machine@1';

/** Trading days after the transition day on which completion is attempted (§2.4). */
export const COMPLETION_DAYS = 5;

export interface MachineSimulationInput {
  definition: MachineDefinition;
  instruments: ReadonlyMap<string, InstrumentRef>;
  inputs: BacktestInputs;
  data: LoadedData;
}

/** The bar series a state-machine run needs (§3: all history when a row reads it). */
export function planMachineSeries(def: MachineDefinition, inputs: BacktestInputs): SeriesPlan[] {
  const exec: MarketExpr[] = machineInstruments(def).map((instrumentId) => ({
    kind: 'market',
    id: `exec:${instrumentId}`,
    instrumentId,
    field: 'close',
    interval: '1d',
    adjustment: inputs.adjustment,
    session: 'regular',
    offset: 0,
  }));
  return planExprs([...machineSeries(def), ...exec], inputs.from, inputs.to);
}

interface Leg {
  instrumentId: string;
  /** Positive buys, negative sells. */
  quantity: Decimal;
  decidedAt: number;
  referencePrice: Decimal;
  /** The transition it moves toward. */
  transition: number;
}

interface Active {
  record: MachineTransitionRecord;
  /** Index into the timeline of the transition's decision close. */
  dayIndex: number;
}

const iso = (t: number) => new Date(t).toISOString();
const str = (d: Decimal, places = 4) => d.toDecimalPlaces(places).toString();
const HUNDRED = new Decimal(100);

/** The winning row's checks, for the transition's Why lines (§2.6). */
function whyLines(
  row: MachineRow | undefined,
  view: MachineView,
  market: MarketView,
  rows: ReadonlyMap<string, MachineRow>,
): ConditionCheck[] {
  if (!row?.condition) return [];
  return machineConditionChecks(row.condition, { view, resolver: market, rows });
}

export function simulateMachine({
  definition: def,
  instruments,
  inputs,
  data,
}: MachineSimulationInput): BacktestResult {
  const warnings = new Map<string, { message: string; count: number }>();
  const warn = (code: string, message: string) => {
    const w = warnings.get(code);
    if (w) w.count++;
    else warnings.set(code, { message, count: 1 });
  };
  for (const w of data.warnings) warn(`data:${w}`, w);

  const machine = def.machine;
  const startStateId = fallbackStateId(machine);
  if (!startStateId)
    throw new Error('A state machine needs an unconditional last row naming a state');
  const states = new Map(machine.states.map((s) => [s.id, s]));
  const rows = new Map(machine.rows.map((r) => [r.id, r]));
  const market = new MarketView(data.series, watchOnlyInstruments(instruments));
  const ids = machineInstruments(def);
  const execKey = (id: string) =>
    seriesKey({
      instrumentId: id,
      interval: '1d',
      adjustment: inputs.adjustment,
      session: 'regular',
    });
  const symbol = (id: string) => instruments.get(id)?.symbol ?? '?';
  const lot = (id: string) => new Decimal(instruments.get(id)?.lotSize ?? '1');

  const slippageBps = new Decimal(inputs.slippageBps);
  const perShare = new Decimal(inputs.commissionPerShare);
  const minCommission = new Decimal(inputs.commissionMin);
  const maxVolumePct = new Decimal(inputs.maxVolumePct);
  const initial = new Decimal(inputs.initialCapital);
  const risk = def.risk;
  const collar = risk.priceCollarPct ? new Decimal(risk.priceCollarPct).div(100) : undefined;
  const commissionFor = (q: Decimal) =>
    q.isZero() ? new Decimal(0) : Decimal.max(q.times(perShare), minCommission);

  // The timeline: every daily bar end of the instruments the machine reads or holds.
  const ends = new Set<number>();
  for (const id of ids)
    for (const b of data.series.get(execKey(id)) ?? []) ends.add(Date.parse(b.end));
  for (const e of machineSeries(def))
    for (const b of data.series.get(seriesKey(e)) ?? []) ends.add(Date.parse(b.end));
  const timeline = [...ends].sort((a, b) => a - b).filter((t) => nyDate(iso(t)) <= inputs.to);
  const dates = timeline.map((t) => nyDate(iso(t)));
  const index = new Map(dates.map((d, i) => [d, i]));
  const sessions = (a: string, b: string) => (index.get(b) ?? 0) - (index.get(a) ?? 0);
  const firstRun = dates.findIndex((d) => d >= inputs.from);

  let cash = initial;
  const holdings = new Map<string, Decimal>();
  const switches: StateSwitch[] = [];
  const start = { stateId: startStateId, on: dates[0] ?? inputs.from };
  const transitions: MachineTransitionRecord[] = [];
  const fills: BacktestFill[] = [];
  const orders: BacktestOrder[] = [];
  const equity: EquityPoint[] = [];
  const pnl = new Map<string, { gross: Decimal; costs: Decimal; fills: number }>();
  const lastPrice = new Map<string, Decimal>();
  let pending: Leg[] = [];
  let pendingFor: Active | undefined;
  let active: Active | undefined;
  let commission = new Decimal(0);
  let slippage = new Decimal(0);
  let peak = initial;
  let prevEquity = initial;
  const decisions: { on: string; decision: DayDecision; current: string }[] = [];

  const closeOf = (id: string) => market.latest(execKey(id))?.close;
  const valueAt = (price: (id: string) => Decimal | undefined) => {
    let v = cash;
    for (const [id, q] of holdings) {
      const p = price(id) ?? lastPrice.get(id);
      if (p) v = v.plus(q.times(p));
    }
    return v;
  };

  const orderRecord = (
    leg: Leg,
    outcome: BacktestOrder['outcome'],
    reason: string | null,
    extra: Partial<BacktestOrder> = {},
  ): BacktestOrder => ({
    cycle: leg.transition,
    phase: leg.quantity.isNegative() ? 'exit' : 'entry',
    legId: `${leg.transition}:${leg.instrumentId}`,
    legLabel: `${leg.quantity.isNegative() ? 'Sell' : 'Buy'} ${symbol(leg.instrumentId)}`,
    instrumentId: leg.instrumentId,
    symbol: symbol(leg.instrumentId),
    side: leg.quantity.isNegative() ? 'sell' : 'buy',
    orderType: 'market',
    timeInForce: 'day',
    outcome,
    reason,
    detail: {},
    decidedAt: iso(leg.decidedAt),
    activeFrom: null,
    endedAt: null,
    quantity: str(leg.quantity.abs(), 6),
    limitPrice: null,
    stopPrice: null,
    referencePrice: str(leg.referencePrice),
    filledQuantity: '0',
    averagePrice: null,
    fills: 0,
    barsWorking: 0,
    bestPrice: null,
    ...extra,
  });

  /** The orders of one attempt, at the open after their decision: sells, then buys from the cash left. */
  const fillPending = (t: number) => {
    const sells = pending.filter((l) => l.quantity.isNegative());
    const buys = pending.filter((l) => l.quantity.gt(0));
    const equityAtDecision = valueAt((id) => lastPrice.get(id));
    for (const leg of [...sells, ...buys]) {
      const bar = market.barEndingNow(execKey(leg.instrumentId));
      if (!bar) {
        orders.push(orderRecord(leg, 'canceled', 'no_bar', { endedAt: iso(t) }));
        continue;
      }
      if (collar && bar.open.minus(leg.referencePrice).abs().div(leg.referencePrice).gt(collar)) {
        orders.push(
          orderRecord(leg, 'canceled', 'price_collar', {
            activeFrom: bar.start,
            endedAt: bar.start,
            detail: { open: str(bar.open), collarPct: risk.priceCollarPct ?? '' },
          }),
        );
        continue;
      }
      const sell = leg.quantity.isNegative();
      const quote = quoteFill(
        { direction: sell ? 'sell' : 'buy', type: 'market', stopTriggered: false },
        bar,
        slippageBps,
      );
      if (!quote) continue;
      const held = holdings.get(leg.instrumentId) ?? new Decimal(0);
      let qty = leg.quantity.abs();
      let reason: string | null = null;
      if (sell) qty = Decimal.min(qty, held);
      else {
        // Buys never exceed the cash the sells left (A4), nor the % of equity limits (§2.8).
        const size = lot(leg.instrumentId);
        const perLot = quote.price.times(size);
        let affordable = cash.div(perLot).floor().times(size);
        while (
          affordable.gt(0) &&
          affordable.times(quote.price).plus(commissionFor(affordable)).gt(cash)
        )
          affordable = affordable.minus(size);
        if (affordable.lt(qty)) {
          qty = Decimal.max(affordable, 0);
          reason = 'cash';
        }
        if (risk.maxOrderPctEquity) {
          const cap = equityAtDecision.times(risk.maxOrderPctEquity).div(100);
          if (qty.times(quote.price).gt(cap)) {
            orders.push(
              orderRecord(leg, 'rejected', 'max_order_pct', {
                activeFrom: bar.start,
                endedAt: bar.start,
                detail: { limitPct: risk.maxOrderPctEquity },
              }),
            );
            continue;
          }
        }
        if (risk.maxStrategyPctEquity) {
          const cap = equityAtDecision.times(risk.maxStrategyPctEquity).div(100);
          let invested = new Decimal(0);
          for (const [id, q] of holdings) invested = invested.plus(q.times(lastPrice.get(id) ?? 0));
          const room = cap.minus(invested).div(quote.price).div(size).floor().times(size);
          if (room.lt(qty)) {
            qty = Decimal.max(room, 0);
            reason = 'max_strategy_pct';
          }
        }
      }
      const cap = volumeCap(bar, maxVolumePct);
      if (cap.lt(qty)) {
        qty = cap;
        reason = 'volume';
      }
      if (!qty.gt(0)) {
        orders.push(
          orderRecord(leg, 'canceled', reason ?? 'nothing_to_trade', { endedAt: bar.start }),
        );
        continue;
      }
      const fee = commissionFor(qty);
      const slip = quote.price.minus(quote.base).abs().times(qty);
      cash = sell
        ? cash.plus(qty.times(quote.price)).minus(fee)
        : cash.minus(qty.times(quote.price)).minus(fee);
      holdings.set(leg.instrumentId, sell ? held.minus(qty) : held.plus(qty));
      commission = commission.plus(fee);
      slippage = slippage.plus(slip);
      const c = pnl.get(leg.instrumentId) ?? {
        gross: new Decimal(0),
        costs: new Decimal(0),
        fills: 0,
      };
      c.costs = c.costs.plus(fee).plus(slip);
      c.fills++;
      pnl.set(leg.instrumentId, c);
      const record = orderRecord(leg, qty.eq(leg.quantity.abs()) ? 'filled' : 'partial', reason, {
        activeFrom: bar.start,
        endedAt: bar.start,
        filledQuantity: str(qty, 6),
        averagePrice: str(quote.price),
        fills: 1,
        barsWorking: 1,
      });
      orders.push(record);
      fills.push({
        time: bar.start,
        cycle: record.cycle,
        legId: record.legId,
        legLabel: record.legLabel,
        phase: record.phase,
        instrumentId: leg.instrumentId,
        symbol: symbol(leg.instrumentId),
        side: record.side,
        quantity: str(qty, 6),
        price: str(quote.price),
        commission: str(fee),
        slippage: str(slip),
      });
    }
    pending = [];
  };

  /** The legs of one attempt toward a state's target, at this close (§2.3). */
  const legsFor = (
    plan: RebalancePlan,
    t: number,
    halted: string | undefined,
    transition: number,
  ): Leg[] => {
    const legs: Leg[] = [];
    for (const l of plan.legs) {
      if (l.quantity.isZero()) continue;
      const ref = closeOf(l.instrumentId) ?? lastPrice.get(l.instrumentId);
      if (!ref) continue;
      const leg = {
        instrumentId: l.instrumentId,
        quantity: l.quantity,
        decidedAt: t,
        referencePrice: ref,
        transition,
      };
      // Rebalance buys count as entries for the daily-loss and drawdown halts (§2.8).
      if (halted && l.quantity.gt(0)) {
        orders.push(orderRecord(leg, 'skipped', halted, { endedAt: iso(t) }));
        continue;
      }
      legs.push(leg);
    }
    const sells = legs.filter((l) => l.quantity.isNegative());
    const buys = legs.filter((l) => l.quantity.gt(0));
    const ordered = [...sells, ...buys];
    const max = risk.maxActiveOrders ?? ordered.length;
    for (const leg of ordered.slice(max))
      orders.push(orderRecord(leg, 'skipped', 'max_active_orders'));
    return ordered.slice(0, max);
  };

  const planFor = (stateId: string, price: (id: string) => Decimal | undefined) => {
    const state = states.get(stateId);
    return state ? planRebalance(state, holdings, cash, price, lot) : undefined;
  };

  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i] as number;
    const on = dates[i] as string;
    market.advance(t);
    const inRun = i >= firstRun && firstRun >= 0;

    // 1. The open: the orders decided at the previous close fill now.
    if (pending.length > 0 && pendingFor) {
      const attempt = pendingFor;
      fillPending(t);
      const opens = (id: string) => market.barEndingNow(execKey(id))?.open;
      const after = planFor(attempt.record.toStateId, opens);
      const k = sessions(
        dates[attempt.dayIndex] as string,
        dates[attempt.record.lastAttemptIndex ?? attempt.dayIndex] as string,
      );
      if (attempt.record.outcome === 'superseded') {
        // A newer transition took over; this attempt's fills still count as trades.
      } else if (after?.done) {
        attempt.record.outcome = 'done';
        attempt.record.completedOn = on;
        if (active === attempt) active = undefined;
      } else if (k >= COMPLETION_DAYS) {
        attempt.record.outcome = 'stuck';
        warn(
          'machine_stuck',
          `A rebalance could not finish within ${COMPLETION_DAYS} trading days; holdings were left as they were until the next switch`,
        );
        if (active === attempt) active = undefined;
      } else attempt.record.outcome = 'incomplete';
      pendingFor = undefined;
    }

    // 2. The close: value the account.
    for (const id of ids) {
      const c = closeOf(id);
      if (c && market.barEndingNow(execKey(id))) lastPrice.set(id, c);
    }
    const eq = valueAt((id) => lastPrice.get(id));
    let halted: string | undefined;
    if (inRun) {
      let gross = new Decimal(0);
      for (const [id, q] of holdings) gross = gross.plus(q.abs().times(lastPrice.get(id) ?? 0));
      equity.push({
        time: iso(t),
        equity: str(eq, 2),
        cash: str(cash, 2),
        grossExposure: str(gross, 2),
        netExposure: str(gross, 2),
      });
      if (risk.dailyLossLimit && prevEquity.minus(eq).gt(risk.dailyLossLimit))
        halted = 'daily_loss';
      if (eq.gt(peak)) peak = eq;
      if (risk.maxDrawdownPct && peak.minus(eq).div(peak).times(HUNDRED).gt(risk.maxDrawdownPct))
        halted = 'drawdown';
      prevEquity = eq;
    }

    // 3. Decide the day (§2, §2.2).
    const view = machineView(start, switches, on, sessions);
    const decision = decideDay(machine, view, market);
    decisions.push({ on, decision, current: view.current });
    if (decision.kind === 'switch')
      switches.push({ on, fromStateId: view.current, toStateId: decision.toStateId });
    if (!inRun) continue;

    const closes = (id: string) => lastPrice.get(id);
    const newTransition = (
      kind: MachineTransitionRecord['kind'],
      from: string | null,
      to: string,
      row: MachineRow | undefined,
    ): Active => {
      if (
        active &&
        (active.record.outcome === 'rebalancing' || active.record.outcome === 'incomplete')
      )
        active.record.outcome = 'superseded';
      const record: MachineTransitionRecord = {
        index: transitions.length + 1,
        kind,
        on,
        fromStateId: from,
        toStateId: to,
        rowId: row?.id ?? null,
        why: whyLines(row, view, market, rows),
        outcome: 'rebalancing',
        attempts: 0,
        orders: 0,
      };
      transitions.push(record);
      return { record, dayIndex: i };
    };
    const attempt = (a: Active, plan: RebalancePlan) => {
      const legs = legsFor(plan, t, halted, a.record.index);
      a.record.attempts++;
      a.record.orders += legs.length;
      a.record.lastAttemptIndex = i;
      if (legs.length > 0) {
        pending = legs;
        pendingFor = a;
      } else if (i + 1 < timeline.length) {
        // Nothing could be placed today (a halt): it stays incomplete and is tried again.
        a.record.outcome = 'incomplete';
        if (sessions(dates[a.dayIndex] as string, on) >= COMPLETION_DAYS) {
          a.record.outcome = 'stuck';
          active = undefined;
        }
      }
    };

    if (decision.kind === 'switch') {
      const a = newTransition('switch', view.current, decision.toStateId, rows.get(decision.rowId));
      const plan = planFor(decision.toStateId, closes);
      if (!plan) {
        a.record.outcome = 'incomplete';
        active = a;
        warn('machine_no_price', 'A rebalance had no price for an instrument and waited for one');
      } else if (plan.underSwitchBand) {
        // Every leg under 5% of equity: the state switches with no orders, done at once (§2.4).
        a.record.outcome = 'switched_no_orders';
        a.record.completedOn = on;
        active = undefined;
      } else {
        active = a;
        attempt(a, plan);
      }
    } else if (i === firstRun) {
      // The run starts holding the replayed state's target (§2.9), as Start does on paper.
      const plan = planFor(view.current, closes);
      if (plan && !plan.done) {
        const a = newTransition('start', null, view.current, undefined);
        active = a;
        attempt(a, plan);
      }
    } else if (active && active.record.outcome === 'incomplete' && pending.length === 0) {
      // Completing the incomplete transition (§2.4), never drift repair.
      const plan = planFor(active.record.toStateId, closes);
      if (plan?.done) {
        active.record.outcome = 'done';
        active.record.completedOn = on;
        active = undefined;
      } else if (plan) attempt(active, plan);
    }
  }

  // Orders decided at the last close never reach an open.
  for (const leg of pending) orders.push(orderRecord(leg, 'not_sent', 'run_ended'));

  // Marked to the last close: each instrument's P/L from its fills and the last price.
  const contributions: InstrumentContribution[] = [];
  for (const id of ids) {
    const c = pnl.get(id);
    if (!c) continue;
    let spent = new Decimal(0);
    for (const f of fills.filter((x) => x.instrumentId === id)) {
      const v = new Decimal(f.quantity).times(f.price);
      spent = f.side === 'buy' ? spent.plus(v) : spent.minus(v);
    }
    // As the rules engine: gross at prices before slippage, net after slippage and commission.
    const atFills = (holdings.get(id) ?? new Decimal(0)).times(lastPrice.get(id) ?? 0).minus(spent);
    const fees = fills
      .filter((x) => x.instrumentId === id)
      .reduce((a, f) => a.plus(f.commission), new Decimal(0));
    contributions.push({
      instrumentId: id,
      symbol: symbol(id),
      legs: [`Rebalance ${symbol(id)}`],
      grossPnl: str(atFills.minus(fees).plus(c.costs), 2),
      costs: str(c.costs, 2),
      netPnl: str(atFills.minus(fees), 2),
      fills: c.fills,
    });
  }

  const report: MachineRunReport = {
    engineVersion: MACHINE_ENGINE_VERSION,
    replayedFrom: dates[0] ?? null,
    startStateId: decisions[firstRun]?.current ?? startStateId,
    finalStateId: switches.at(-1)?.toStateId ?? startStateId,
    states: machine.states.map((s) => ({ id: s.id, name: s.name })),
    transitions,
    stays: stateStays(decisions.slice(Math.max(firstRun, 0)), equity),
    notApplicable: ['cycles', 'closedCycles', 'winRatePct', 'profitFactor'],
  };

  return {
    engineVersion: MACHINE_ENGINE_VERSION,
    dataVersions: data.dataVersions,
    assumptions: [...describeAssumptions({ ...inputs, interval: '1d' }), ...MACHINE_ASSUMPTIONS],
    sharpeMethod: SHARPE_METHOD,
    metrics: computeMetrics({
      initial,
      equity,
      trades: [],
      orders: orders.length,
      fills: fills.length,
      commission,
      slippage,
      borrow: new Decimal(0),
    }),
    equity,
    trades: [],
    fills,
    contributions,
    warnings: [...warnings].map(([code, w]) => ({ code, ...w })),
    orders,
    symbols: Object.fromEntries(ids.map((id) => [id, symbol(id)])),
    machine: report,
  };
}

export const MACHINE_ASSUMPTIONS = [
  'State machine: each daily close decides the state; a switch rebalances at the next open, sells first, then buys from the cash they leave',
  'Legs under 0.5% of equity are not traded; a switch whose every leg is under 5% of equity changes state without orders',
  'A rebalance that does not finish is completed on the next closes for up to 5 trading days, then left as it is',
  'The state path is replayed over every loaded bar before the first day, with no orders, and the run starts holding that state',
];

/** Time and return in each stay of a state within the run (§2.6). */
function stateStays(
  days: readonly { on: string; decision: DayDecision; current: string }[],
  equity: readonly EquityPoint[],
): StateStay[] {
  const stays: StateStay[] = [];
  const eqOn = new Map(equity.map((p) => [nyDate(p.time), new Decimal(p.equity)]));
  let open: { stateId: string; from: string; days: number } | undefined;
  for (const d of days) {
    if (!open) open = { stateId: d.current, from: d.on, days: 0 };
    open.days++;
    if (d.decision.kind === 'switch') {
      stays.push(closeStay(open, d.on, eqOn));
      open = { stateId: d.decision.toStateId, from: d.on, days: 0 };
    }
  }
  const last = days.at(-1);
  if (open && last && open.days > 0) stays.push(closeStay(open, last.on, eqOn, true));
  return stays;
}

function closeStay(
  open: { stateId: string; from: string; days: number },
  to: string,
  eqOn: ReadonlyMap<string, Decimal>,
  ongoing = false,
): StateStay {
  const a = eqOn.get(open.from);
  const b = eqOn.get(to);
  return {
    stateId: open.stateId,
    from: open.from,
    to,
    sessions: open.days,
    returnPct: a && b && a.gt(0) ? str(b.minus(a).div(a).times(HUNDRED), 2) : null,
    ongoing,
  };
}
