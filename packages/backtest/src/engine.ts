import {
  evaluateCondition,
  evaluateExpr,
  nyDate,
  nextTradingDay,
  regularSession,
  relativeDelaySeconds,
  SUBSTITUTED_FIELDS,
  type OrderSide,
  type PhaseEvent,
  type PhaseName,
  type PlannedOrder,
  type StrategyDefinition,
  type Truth,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { seriesExprs, seriesKey, type InstrumentRef, type LoadedData } from './data';
import { quoteFill, stopReached, volumeCap, type Direction } from './fills';
import { describeAssumptions, type BacktestInputs } from './inputs';
import { MarketView } from './market';
import { computeMetrics } from './metrics';
import {
  ENGINE_VERSION,
  SHARPE_METHOD,
  type BacktestFill,
  type BacktestResult,
  type BacktestTrade,
  type EquityPoint,
  type InstrumentContribution,
} from './results';

/**
 * The back-test engine (Design v1.0 §7.2). It replays bars in time order and
 * runs the strategy through the same condition evaluator the runtime uses.
 *
 * At each bar close it:
 * 1. fills working orders against the bar that just ended;
 * 2. charges borrow, values positions and applies daily-loss and drawdown halts;
 * 3. expires and times out orders and settles each cycle's progress;
 * 4. evaluates Entry and Exit conditions on closed bars only and submits the
 *    legs whose timing is due.
 * Orders placed at a close can only fill on later bars, so no decision can
 * see the price it trades at.
 */

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

type LegStatus = 'waiting' | 'working' | 'filled' | 'partial' | 'failed' | 'skipped' | 'canceled';
const TERMINAL: readonly LegStatus[] = ['filled', 'partial', 'failed', 'skipped', 'canceled'];

interface Order {
  id: number;
  cycle: Cycle;
  leg: LegState;
  instrumentId: string;
  direction: Direction;
  type: PlannedOrder['orderType'];
  limit?: Decimal | undefined;
  stop?: Decimal | undefined;
  stopTriggered: boolean;
  tif: PlannedOrder['timeInForce'];
  quantity: Decimal;
  filled: Decimal;
  /** Reference price when submitted, for the price collar. */
  reference: Decimal;
  /** When the order can first fill: the decision time, or the next open if the market was closed. */
  activeFrom: number;
  firstBarSeen: boolean;
  closing: boolean;
}

interface LegState {
  leg: PlannedOrder;
  phase: PhaseName | 'flatten';
  side: OrderSide;
  status: LegStatus;
  order?: Order;
  quantity: Decimal;
  filled: Decimal;
  cost: Decimal;
  submittedAt?: number;
  filledAt?: number;
}

interface TriggerState {
  prev: Truth;
  consecutive: number;
  lastFired?: number;
  fired: number;
}

interface CyclePosition {
  quantity: Decimal;
  /** Cash flows at actual prices (net) and before slippage (gross). */
  cash: Decimal;
  grossCash: Decimal;
  commission: Decimal;
  slippage: Decimal;
  borrow: Decimal;
}

interface Cycle {
  no: number;
  state: 'entering' | 'open' | 'exiting' | 'closed' | 'aborted';
  entryTriggeredAt?: number;
  events: Map<PhaseEvent, number>;
  legEvents: Map<string, number>;
  entryLegs: LegState[];
  exitLegs: LegState[];
  flattenLegs: LegState[];
  entries: number;
  positions: Map<string, CyclePosition>;
  exitTrigger: TriggerState;
  firstFill?: number;
  lastFill?: number;
  entryValue: Decimal;
}

export interface SimulationInput {
  definition: StrategyDefinition;
  instruments: ReadonlyMap<string, InstrumentRef>;
  inputs: BacktestInputs;
  data: LoadedData;
}

class Warnings {
  private readonly map = new Map<string, { message: string; count: number }>();
  add(code: string, message: string, count = 1) {
    const w = this.map.get(code);
    if (w) w.count += count;
    else this.map.set(code, { message, count });
  }
  list() {
    return [...this.map].map(([code, w]) => ({ code, ...w }));
  }
}

const iso = (t: number) => new Date(t).toISOString();

function legOrderFor(def: StrategyDefinition, phase: PhaseName): PlannedOrder[] {
  const orders = def[phase].orders;
  if (def.execution.multiLegPolicy === 'concurrent' || !def.execution.legOrder) return orders;
  const rank = new Map(def.execution.legOrder.map((id, i) => [id, i]));
  return [...orders].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Advances an Entry or Exit trigger by one evaluation and says whether it fires (§6.5). */
function stepTrigger(
  state: TriggerState,
  truth: Truth,
  now: number,
  trigger: StrategyDefinition['entry']['trigger'],
): boolean {
  const prev = state.prev;
  state.prev = truth;
  state.consecutive = truth === true ? state.consecutive + 1 : 0;
  if (truth !== true || state.consecutive < trigger.confirmationBars + 1) return false;
  if (state.lastFired !== undefined && now - state.lastFired < trigger.cooldownSec * 1000) {
    return false;
  }
  if (trigger.mode === 'on_transition') {
    // Fires once per run of true values: on the bar that completes the confirmation.
    const justConfirmed = state.consecutive === trigger.confirmationBars + 1;
    if (!justConfirmed || (trigger.confirmationBars === 0 && prev !== false)) return false;
  }
  if (trigger.mode === 'once_per_cycle' && state.fired > 0) return false;
  state.lastFired = now;
  state.fired += 1;
  return true;
}

export function simulate({
  definition: def,
  instruments,
  inputs,
  data,
}: SimulationInput): BacktestResult {
  const warnings = new Warnings();
  for (const w of data.warnings) warnings.add(`data:${w}`, w);
  const view = new MarketView(data.series);
  const ex = def.execution;
  const risk = def.risk;
  const slippageBps = new Decimal(inputs.slippageBps);
  const perShare = new Decimal(inputs.commissionPerShare);
  const minCommission = new Decimal(inputs.commissionMin);
  const maxVolumePct = new Decimal(inputs.maxVolumePct);
  const borrowRate = new Decimal(inputs.borrowRatePct).div(100).div(252);
  const initial = new Decimal(inputs.initialCapital);

  if (seriesExprs(def).some((e) => SUBSTITUTED_FIELDS.includes(e.field))) {
    warnings.add(
      'quote_fields',
      'Bars have no quotes, so last, bid, ask and mid use the bar close and VWAP uses the typical price',
    );
  }

  const execKey = (instrumentId: string) =>
    seriesKey({
      instrumentId,
      interval: inputs.interval,
      adjustment: inputs.adjustment,
      session: 'regular',
    });
  const usedInstruments = new Set<string>([
    ...seriesExprs(def).map((e) => e.instrumentId),
    ...def.entry.orders.map((o) => o.instrumentId),
    ...def.exit.orders.map((o) => o.instrumentId),
  ]);
  const symbol = (id: string) => instruments.get(id)?.symbol ?? '?';
  const lot = (id: string) => new Decimal(instruments.get(id)?.lotSize ?? '1');

  // The clock: every execution bar end inside the requested dates.
  const stepSet = new Set<number>();
  for (const id of usedInstruments) {
    for (const bar of data.series.get(execKey(id)) ?? []) {
      const day = nyDate(bar.start);
      if (day >= inputs.from && day <= inputs.to) stepSet.add(Date.parse(bar.end));
    }
  }
  const steps = [...stepSet].sort((a, b) => a - b);
  if (steps.length === 0) warnings.add('no_bars', 'There are no bars in the selected dates');

  let cash = initial;
  const portfolio = new Map<string, Decimal>();
  const cycles: Cycle[] = [];
  const orders: Order[] = [];
  const fills: BacktestFill[] = [];
  const equity: EquityPoint[] = [];
  const entryTrigger: TriggerState = { prev: undefined, consecutive: 0, fired: 0 };
  let orderSeq = 0;
  let submitted = 0;
  let commissionTotal = ZERO;
  let slippageTotal = ZERO;
  let borrowTotal = ZERO;
  let currentDay = '';
  let dayStartEquity = initial;
  let dailyHalt = false;
  let drawdownHalt = false;
  let peak = initial;
  let unknownEntrySteps = 0;
  let staleSteps = 0;
  const exactUsed = new Set<string>();

  const mark = (id: string) => view.latest(execKey(id))?.close;
  const positionValue = () => {
    let gross = ZERO;
    let net = ZERO;
    for (const [id, q] of portfolio) {
      const px = mark(id);
      if (!px || q.isZero()) continue;
      gross = gross.plus(q.abs().times(px));
      net = net.plus(q.times(px));
    }
    return { gross, net };
  };
  const equityNow = () => cash.plus(positionValue().net);
  const working = () => orders.filter((o) => o.leg.status === 'working');

  const position = (c: Cycle, id: string): CyclePosition => {
    let p = c.positions.get(id);
    if (!p) {
      p = {
        quantity: ZERO,
        cash: ZERO,
        grossCash: ZERO,
        commission: ZERO,
        slippage: ZERO,
        borrow: ZERO,
      };
      c.positions.set(id, p);
    }
    return p;
  };

  // ---------------------------------------------------------------------------
  // Orders

  function endLeg(leg: LegState, status: LegStatus, now: number, code?: string, message?: string) {
    if (TERMINAL.includes(leg.status)) return;
    leg.status = leg.filled.gt(0) && status !== 'filled' ? 'partial' : status;
    if (code && message) warnings.add(code, message);
    if (leg.status === 'filled') leg.filledAt = now;
  }

  /** Reacts to a leg that ended without filling fully, per the multi-leg policy (§6.7). */
  function onLegProblem(c: Cycle, leg: LegState, now: number) {
    if (leg.phase === 'flatten') return;
    const phaseLegs = leg.phase === 'entry' ? c.entryLegs : c.exitLegs;
    if (def[leg.phase].orders.length < 2) return;
    warnings.add('leg_failed', 'A leg of a multi-leg plan did not fill completely in time');
    if (ex.onLegFailure === 'leave_and_alert') return;
    for (const other of phaseLegs) {
      if (other === leg) continue;
      if (other.status === 'waiting') other.status = 'canceled';
      if (other.status === 'working') endLeg(other, 'canceled', now);
    }
    if (ex.onLegFailure === 'flatten_filled') flatten(c, now);
  }

  function flatten(c: Cycle, now: number) {
    for (const [id, p] of c.positions) {
      if (p.quantity.isZero()) continue;
      const side: OrderSide = p.quantity.gt(0) ? 'sell' : 'buy_to_cover';
      const leg: LegState = {
        leg: {
          id: `flatten-${id}`,
          legLabel: `Close ${symbol(id)}`,
          instrumentId: id,
          accountId: '',
          side,
          quantity: { type: 'units', value: p.quantity.abs().toString(), rounding: 'down' },
          orderType: 'market',
          timeInForce: 'day',
          extendedHours: false,
          timing: { mode: 'immediate' },
          timingOnly: false,
        },
        phase: 'flatten',
        side,
        status: 'waiting',
        quantity: p.quantity.abs(),
        filled: ZERO,
        cost: ZERO,
      };
      c.flattenLegs.push(leg);
      placeOrder(c, leg, p.quantity.abs(), p.quantity.gt(0) ? 'sell' : 'buy', true, now);
    }
    warnings.add('flattened', 'Filled legs were closed after another leg failed');
  }

  function activeFromFor(now: number): number | undefined {
    const day = nyDate(iso(now));
    const session = regularSession(day);
    if (session && now >= Date.parse(session.open) && now < Date.parse(session.close)) return now;
    if (ex.marketHoursPolicy === 'cancel') return undefined;
    if (ex.marketHoursPolicy === 'extended_if_supported') {
      warnings.add(
        'no_extended_hours',
        'The data has no extended-hours bars, so orders waited for the regular session',
      );
    }
    const next =
      session && now < Date.parse(session.open) ? session : regularSession(nextTradingDay(day));
    return next ? Date.parse(next.open) : undefined;
  }

  function placeOrder(
    c: Cycle,
    leg: LegState,
    quantity: Decimal,
    direction: Direction,
    closing: boolean,
    now: number,
    prices: { limit?: Decimal | undefined; stop?: Decimal | undefined } = {},
  ): boolean {
    const activeFrom = activeFromFor(now);
    if (activeFrom === undefined) {
      endLeg(
        leg,
        'failed',
        now,
        'market_closed',
        'Orders were canceled because the market was closed',
      );
      return false;
    }
    const order: Order = {
      id: ++orderSeq,
      cycle: c,
      leg,
      instrumentId: leg.leg.instrumentId,
      direction,
      type: leg.leg.orderType,
      limit: prices.limit,
      stop: prices.stop,
      stopTriggered: false,
      tif: leg.leg.timeInForce,
      quantity,
      filled: ZERO,
      reference: mark(leg.leg.instrumentId) ?? ZERO,
      activeFrom,
      firstBarSeen: false,
      closing,
    };
    orders.push(order);
    submitted += 1;
    leg.order = order;
    leg.quantity = quantity;
    leg.status = 'working';
    leg.submittedAt = activeFrom;
    c.legEvents.set(`${leg.leg.id}:submitted`, activeFrom);
    if (leg.phase === 'entry' && !c.events.has('entry_submitted'))
      c.events.set('entry_submitted', activeFrom);
    return true;
  }

  const reject = (leg: LegState, now: number, code: string, message: string) => {
    endLeg(leg, 'failed', now, code, message);
    return false;
  };

  /** Sizes, risk-checks and places one leg (§6.6, §8.6). */
  function submitLeg(c: Cycle, leg: LegState, now: number): boolean {
    const o = leg.leg;
    const ref = mark(o.instrumentId);
    if (!ref || ref.lte(0))
      return reject(
        leg,
        now,
        'no_price',
        'Some orders were skipped because there was no price yet',
      );
    const pos = position(c, o.instrumentId).quantity;
    const price = (e: PlannedOrder['limitPrice']) => (e ? evaluateExpr(e, view) : undefined);
    const limit = price(o.limitPrice);
    const stop = price(o.stopPrice);
    if ((o.limitPrice && !limit) || (o.stopPrice && !stop)) {
      return reject(
        leg,
        now,
        'price_unavailable',
        'Some orders were skipped because their limit or stop price could not be computed',
      );
    }

    let qty: Decimal;
    const v = new Decimal(o.quantity.value);
    switch (o.quantity.type) {
      case 'units':
        qty = v;
        break;
      case 'notional':
        qty = v.div(ref);
        break;
      case 'pct_equity':
        qty = equityNow().times(v).div(100).div(ref);
        break;
      case 'risk_sized': {
        const perShareRisk = stop ? ref.minus(stop).abs() : ZERO;
        if (perShareRisk.isZero())
          return reject(
            leg,
            now,
            'no_stop_distance',
            'Risk-sized orders were skipped because the stop was at the current price',
          );
        qty = v.div(perShareRisk);
        break;
      }
    }
    const step = lot(o.instrumentId);
    const lots = qty.div(step);
    qty = (o.quantity.rounding === 'nearest' ? lots.round() : lots.floor()).times(step);

    let direction: Direction;
    let closing = false;
    switch (o.side) {
      case 'buy':
        direction = 'buy';
        break;
      case 'sell_short':
        direction = 'sell';
        break;
      case 'sell':
        direction = 'sell';
        closing = true;
        qty = Decimal.min(qty, Decimal.max(pos, 0));
        break;
      case 'buy_to_cover':
        direction = 'buy';
        closing = true;
        qty = Decimal.min(qty, Decimal.max(pos.negated(), 0));
        break;
      case 'close':
        direction = pos.gt(0) ? 'sell' : 'buy';
        closing = true;
        qty = pos.abs();
        break;
      case 'reduce':
        direction = pos.gt(0) ? 'sell' : 'buy';
        closing = true;
        qty = Decimal.min(qty, pos.abs());
        break;
    }
    if (qty.lte(0)) {
      endLeg(
        leg,
        'skipped',
        now,
        closing ? 'nothing_to_close' : 'zero_quantity',
        closing
          ? 'Some Exit legs had no position left to close'
          : 'Some orders were skipped because their quantity rounded to zero',
      );
      return false;
    }

    // Pre-trade risk checks (§8.6). Closing orders always pass; they reduce risk.
    if (risk.maxActiveOrders !== undefined && working().length >= risk.maxActiveOrders) {
      return reject(
        leg,
        now,
        'risk_active_orders',
        'Orders were rejected by the maximum active orders limit',
      );
    }
    if (!closing) {
      const notional = qty.times(ref);
      if (risk.maxOrderNotional && notional.gt(risk.maxOrderNotional)) {
        return reject(
          leg,
          now,
          'risk_order_size',
          'Orders were rejected by the maximum order size',
        );
      }
      const { gross } = positionValue();
      if (risk.maxStrategyExposure && gross.plus(notional).gt(risk.maxStrategyExposure)) {
        return reject(
          leg,
          now,
          'risk_exposure',
          'Orders were rejected by the maximum strategy exposure',
        );
      }
      if (gross.plus(notional).gt(equityNow())) {
        return reject(
          leg,
          now,
          'buying_power',
          'Orders were rejected for lack of buying power (no leverage)',
        );
      }
      if (dailyHalt)
        return reject(
          leg,
          now,
          'risk_daily_loss',
          'New entries stopped for the day after the daily loss limit was hit',
        );
      if (drawdownHalt)
        return reject(
          leg,
          now,
          'risk_drawdown',
          'New entries stopped after the maximum drawdown was hit',
        );
      if (risk.maxOpenPositions !== undefined && (portfolio.get(o.instrumentId) ?? ZERO).isZero()) {
        const open = [...portfolio.values()].filter((q) => !q.isZero()).length;
        if (open >= risk.maxOpenPositions) {
          return reject(
            leg,
            now,
            'risk_open_positions',
            'Orders were rejected by the maximum open positions',
          );
        }
      }
    }
    const collar = risk.priceCollarPct ? new Decimal(risk.priceCollarPct) : undefined;
    if (collar && limit && limit.minus(ref).abs().div(ref).times(100).gt(collar)) {
      return reject(leg, now, 'risk_collar', 'Limit orders were rejected by the price collar');
    }
    return placeOrder(c, leg, qty, direction, closing, now, { limit, stop });
  }

  function applyFill(order: Order, qty: Decimal, price: Decimal, base: Decimal, at: number) {
    const c = order.cycle;
    const sign = order.direction === 'buy' ? 1 : -1;
    const commission =
      perShare.isZero() && minCommission.isZero()
        ? ZERO
        : Decimal.max(qty.times(perShare), minCommission);
    const slip = price.minus(base).abs().times(qty);
    cash = cash.minus(price.times(qty).times(sign)).minus(commission);
    const p = position(c, order.instrumentId);
    p.quantity = p.quantity.plus(qty.times(sign));
    p.cash = p.cash.minus(price.times(qty).times(sign)).minus(commission);
    p.grossCash = p.grossCash.minus(base.times(qty).times(sign));
    p.commission = p.commission.plus(commission);
    p.slippage = p.slippage.plus(slip);
    portfolio.set(
      order.instrumentId,
      (portfolio.get(order.instrumentId) ?? ZERO).plus(qty.times(sign)),
    );
    commissionTotal = commissionTotal.plus(commission);
    slippageTotal = slippageTotal.plus(slip);
    order.filled = order.filled.plus(qty);
    const leg = order.leg;
    leg.cost = leg.cost.plus(price.times(qty));
    leg.filled = leg.filled.plus(qty);
    c.firstFill ??= at;
    c.lastFill = at;
    if (leg.phase === 'entry') {
      c.entryValue = c.entryValue.plus(price.times(qty));
      if (!c.events.has('entry_partial_fill')) c.events.set('entry_partial_fill', at);
    }
    fills.push({
      time: iso(at),
      cycle: c.no,
      legId: leg.leg.id,
      legLabel: leg.leg.legLabel,
      phase: leg.phase,
      instrumentId: order.instrumentId,
      symbol: symbol(order.instrumentId),
      side: leg.side,
      quantity: qty.toString(),
      price: price.toDecimalPlaces(4).toString(),
      commission: commission.toDecimalPlaces(2).toString(),
      slippage: slip.toDecimalPlaces(2).toString(),
    });
    if (order.filled.gte(order.quantity)) {
      endLeg(leg, 'filled', at);
      c.legEvents.set(`${leg.leg.id}:filled`, at);
    }
  }

  function tryFill(order: Order, now: number) {
    const bar = view.barEndingNow(execKey(order.instrumentId));
    if (!bar || Date.parse(bar.start) < order.activeFrom) return;
    const at = Date.parse(bar.start);
    const first = !order.firstBarSeen;
    order.firstBarSeen = true;
    const leg = order.leg;
    const quote = quoteFill(order, bar, slippageBps);
    if (!quote) {
      if (stopReached(order, bar)) order.stopTriggered = true;
    } else {
      order.stopTriggered = quote.stopTriggered;
      const collar = risk.priceCollarPct ? new Decimal(risk.priceCollarPct) : undefined;
      const marketable = order.type === 'market' || order.type === 'stop';
      if (
        collar &&
        marketable &&
        !order.closing &&
        order.reference.gt(0) &&
        quote.base.minus(order.reference).abs().div(order.reference).times(100).gt(collar)
      ) {
        endLeg(
          leg,
          'canceled',
          now,
          'collar_cancel',
          'Orders were canceled because the price moved beyond the price collar',
        );
        onLegProblem(order.cycle, leg, now);
        return;
      }
      let qty = Decimal.min(order.quantity.minus(order.filled), volumeCap(bar, maxVolumePct));
      if (order.closing) {
        const pos = position(order.cycle, order.instrumentId).quantity;
        qty = Decimal.min(qty, pos.abs());
      }
      if (order.tif === 'fok' && qty.lt(order.quantity)) {
        endLeg(
          leg,
          'canceled',
          now,
          'fok_canceled',
          'Fill-or-kill orders were canceled because they could not fill in full',
        );
        onLegProblem(order.cycle, leg, now);
        return;
      }
      if (qty.lt(order.quantity.minus(order.filled))) {
        warnings.add(
          'volume_cap',
          'Some orders filled over several bars because of the volume cap',
        );
      }
      if (qty.gt(0)) applyFill(order, qty, quote.price, quote.base, at);
    }
    if (leg.status === 'working' && first && (order.tif === 'ioc' || order.tif === 'fok')) {
      endLeg(leg, 'canceled', now, 'ioc_canceled', 'Immediate-or-cancel orders left part unfilled');
      onLegProblem(order.cycle, leg, now);
    }
  }

  // ---------------------------------------------------------------------------
  // Cycles

  const activeCycles = () => cycles.filter((c) => c.state !== 'closed' && c.state !== 'aborted');

  function newCycle(now: number, triggered: boolean): Cycle {
    const c: Cycle = {
      no: cycles.length + 1,
      state: 'entering',
      events: new Map(),
      legEvents: new Map(),
      entryLegs: [],
      exitLegs: [],
      flattenLegs: [],
      entries: 0,
      positions: new Map(),
      exitTrigger: { prev: false, consecutive: 0, fired: 0 },
      entryValue: ZERO,
    };
    if (triggered) {
      c.entryTriggeredAt = now;
      c.events.set('entry_trigger', now);
    }
    addEntryBatch(c);
    cycles.push(c);
    return c;
  }

  const legState = (leg: PlannedOrder, phase: PhaseName): LegState => ({
    leg,
    phase,
    side: leg.side,
    status: 'waiting',
    quantity: ZERO,
    filled: ZERO,
    cost: ZERO,
  });

  function addEntryBatch(c: Cycle) {
    c.entries += 1;
    c.entryLegs.push(...legOrderFor(def, 'entry').map((l) => legState(l, 'entry')));
  }

  function timingDue(c: Cycle, s: LegState, triggeredAt: number | undefined, now: number): boolean {
    const t = s.leg.timing;
    const needsTrigger = t.mode === 'immediate' || !s.leg.timingOnly;
    if (needsTrigger && triggeredAt === undefined) return false;
    if (t.mode === 'immediate') return true;
    if (t.mode === 'exact') return now >= Date.parse(t.at);
    const ref =
      t.reference.kind === 'phase'
        ? c.events.get(t.reference.event)
        : c.legEvents.get(`${t.reference.legId}:${t.reference.event}`);
    return ref !== undefined && now >= ref + relativeDelaySeconds(t) * 1000;
  }

  function scheduleLegs(c: Cycle, legs: LegState[], triggeredAt: number | undefined, now: number) {
    let prev: LegState | undefined;
    for (const s of legs) {
      const blockedByPrev =
        prev !== undefined &&
        ((ex.multiLegPolicy === 'after_prior_fill' && prev.status !== 'filled') ||
          (ex.multiLegPolicy === 'sequential' && prev.status === 'waiting'));
      if (s.status === 'waiting' && !blockedByPrev && timingDue(c, s, triggeredAt, now)) {
        // submitLeg changes the status, which TypeScript narrowed to 'waiting' above.
        const placed = submitLeg(c, s, now);
        const after = s.status as LegStatus;
        if (!placed && TERMINAL.includes(after) && after !== 'skipped') onLegProblem(c, s, now);
      }
      prev = s;
    }
  }

  const flat = (c: Cycle) => [...c.positions.values()].every((p) => p.quantity.isZero());

  /** Moves a cycle forward once its legs settle (§6.9). */
  function settle(c: Cycle, now: number) {
    if (
      c.state === 'entering' ||
      (c.state === 'open' && c.entryLegs.some((l) => !TERMINAL.includes(l.status)))
    ) {
      const started = c.entryLegs.filter((l) => l.status !== 'waiting');
      const done = c.entryLegs.every((l) => TERMINAL.includes(l.status));
      const anyFill = c.entryLegs.some((l) => l.filled.gt(0));
      if (c.state === 'entering') {
        if (done && !anyFill) {
          c.state = 'aborted';
          return;
        }
        const milestone = ex.entryMilestone === 'partial_fill' ? anyFill : done && anyFill;
        if (milestone) {
          c.state = 'open';
          c.events.set('position_opened', c.lastFill ?? now);
          if (
            c.entryLegs.some(
              (l) => l.status === 'partial' || l.status === 'failed' || l.status === 'canceled',
            )
          ) {
            warnings.add(
              'entry_incomplete',
              'Some cycles opened with part of the Entry plan unfilled',
            );
          }
        }
      }
      if (
        done &&
        anyFill &&
        !c.events.has('entry_full_fill') &&
        c.entryLegs.every((l) => l.status === 'filled')
      ) {
        c.events.set('entry_full_fill', c.lastFill ?? now);
      }
      if (started.length === 0) return;
    }
    if (c.state === 'exiting' || c.state === 'open') {
      const exitDone =
        c.exitLegs.length > 0 && c.exitLegs.every((l) => TERMINAL.includes(l.status));
      const flattenDone = c.flattenLegs.every((l) => TERMINAL.includes(l.status));
      const entryDone = c.entryLegs.every((l) => TERMINAL.includes(l.status));
      if (flat(c) && entryDone && flattenDone && (exitDone || c.flattenLegs.length > 0)) {
        c.state = 'closed';
        return;
      }
      if (c.state === 'exiting' && exitDone && flattenDone) {
        // Something is still held: watch the Exit conditions again.
        warnings.add(
          'exit_incomplete',
          'Some cycles still held positions after their Exit legs finished',
        );
        c.state = 'open';
        c.exitLegs = legOrderFor(def, 'exit').map((l) => legState(l, 'exit'));
        c.exitTrigger = { prev: false, consecutive: 0, fired: 0 };
      }
    }
    if (
      c.state === 'entering' &&
      c.flattenLegs.length > 0 &&
      flat(c) &&
      c.flattenLegs.every((l) => TERMINAL.includes(l.status))
    ) {
      c.state = 'closed';
    }
  }

  // ---------------------------------------------------------------------------
  // The clock

  for (const now of steps) {
    view.advance(now);

    // 1. Fills on the bars that just closed.
    for (const order of working()) tryFill(order, now);

    // 2. Borrow at each close, then valuation and halts.
    const day = nyDate(iso(now));
    const session = regularSession(day);
    if (day !== currentDay) {
      currentDay = day;
      const last = equity.at(-1);
      dayStartEquity = last ? new Decimal(last.equity) : initial;
      dailyHalt = false;
    }
    if (session && Date.parse(session.close) === now && borrowRate.gt(0)) {
      for (const c of cycles) {
        for (const [id, p] of c.positions) {
          const px = mark(id);
          if (!px || p.quantity.gte(0)) continue;
          const cost = p.quantity.abs().times(px).times(borrowRate);
          p.borrow = p.borrow.plus(cost);
          p.cash = p.cash.minus(cost);
          cash = cash.minus(cost);
          borrowTotal = borrowTotal.plus(cost);
        }
      }
    }
    const eq = equityNow();
    if (risk.dailyLossLimit && !dailyHalt && dayStartEquity.minus(eq).gte(risk.dailyLossLimit)) {
      dailyHalt = true;
      warnings.add(
        'daily_loss_halt',
        'The daily loss limit stopped new entries for the rest of the day',
      );
    }
    if (eq.gt(peak)) peak = eq;
    if (
      risk.maxDrawdownPct &&
      !drawdownHalt &&
      peak.minus(eq).div(peak).times(100).gte(risk.maxDrawdownPct)
    ) {
      drawdownHalt = true;
      warnings.add(
        'drawdown_halt',
        'The maximum drawdown stopped new entries for the rest of the test',
      );
    }

    // 3. Expiry and leg timeouts, then settle every cycle.
    for (const order of working()) {
      const sessionOf = regularSession(nyDate(iso(order.activeFrom)));
      if (order.tif === 'day' && sessionOf && now >= Date.parse(sessionOf.close)) {
        endLeg(
          order.leg,
          'canceled',
          now,
          'day_expired',
          'Day orders expired unfilled at the close',
        );
        onLegProblem(order.cycle, order.leg, now);
        continue;
      }
      const phase = order.leg.phase;
      const multiLeg = phase !== 'flatten' && def[phase].orders.length > 1;
      if (multiLeg && now - order.activeFrom > ex.legTimeoutSec * 1000) {
        endLeg(
          order.leg,
          'canceled',
          now,
          'leg_timeout',
          'Legs were canceled after the leg timeout',
        );
        onLegProblem(order.cycle, order.leg, now);
      }
    }
    for (const c of activeCycles()) settle(c, now);

    // 4. Conditions on closed bars, then due legs.
    if (
      [...usedInstruments].some(
        (id) => view.latest(execKey(id)) && seriesExprs(def).some((e) => view.isStale(e)),
      )
    ) {
      staleSteps += 1;
    }
    const entryTruth = evaluateCondition(def.entry.condition, view);
    if (entryTruth === undefined) unknownEntrySteps += 1;
    const fires = stepTrigger(entryTrigger, entryTruth, now, def.entry.trigger);
    const active = activeCycles();
    if (fires && !dailyHalt && !drawdownHalt) {
      const mode = ex.reentry.mode;
      const current = active.at(-1);
      if (current && current.entryTriggeredAt === undefined && current.state === 'entering') {
        current.entryTriggeredAt = now;
        current.events.set('entry_trigger', now);
      } else if (active.length === 0 || mode === 'independent_cycles') {
        newCycle(now, true);
      } else if (
        mode === 'pyramid' &&
        current &&
        current.state === 'open' &&
        current.entries < (ex.reentry.cap ?? 1)
      ) {
        addEntryBatch(current);
      }
    }
    // Timing-only exact Entry legs open a cycle at their time without the condition (§6.8).
    if (activeCycles().length === 0 && !dailyHalt && !drawdownHalt) {
      const due = def.entry.orders.find(
        (o) =>
          o.timingOnly &&
          o.timing.mode === 'exact' &&
          !exactUsed.has(o.id) &&
          now >= Date.parse(o.timing.at),
      );
      if (due) {
        exactUsed.add(due.id);
        newCycle(now, false);
      }
    }

    for (const c of activeCycles()) {
      scheduleLegs(c, c.entryLegs, c.entryTriggeredAt, now);
      if (c.state === 'open') {
        const truth = evaluateCondition(def.exit.condition, view);
        if (stepTrigger(c.exitTrigger, truth, now, def.exit.trigger)) {
          c.state = 'exiting';
          c.events.set('entry_trigger', c.events.get('entry_trigger') ?? now);
          c.legEvents.set('exit:trigger', now);
        }
        if (c.exitLegs.length === 0)
          c.exitLegs = legOrderFor(def, 'exit').map((l) => legState(l, 'exit'));
      }
      if (c.state === 'open' || c.state === 'exiting') {
        const exitTriggeredAt = c.state === 'exiting' ? c.legEvents.get('exit:trigger') : undefined;
        scheduleLegs(c, c.exitLegs, exitTriggeredAt, now);
        if (c.state === 'open' && c.exitLegs.some((l) => l.status !== 'waiting'))
          c.state = 'exiting';
      }
      settle(c, now);
    }

    const { gross, net } = positionValue();
    equity.push({
      time: iso(now),
      equity: cash.plus(net).toDecimalPlaces(2).toString(),
      cash: cash.toDecimalPlaces(2).toString(),
      grossExposure: gross.toDecimalPlaces(2).toString(),
      netExposure: net.toDecimalPlaces(2).toString(),
    });
  }

  // ---------------------------------------------------------------------------
  // Wrap up

  const stillWorking = working().length;
  if (stillWorking > 0)
    warnings.add(
      'working_at_end',
      'Orders still working when the test ended were not filled',
      stillWorking,
    );
  const openAtEnd = activeCycles().filter(
    (c) => c.state !== 'entering' || c.firstFill !== undefined,
  );
  if (openAtEnd.length > 0) {
    warnings.add(
      'open_at_end',
      'Cycles still open at the end are valued at the last close',
      openAtEnd.length,
    );
  }
  if (steps.length > 0 && unknownEntrySteps / steps.length > 0.2) {
    warnings.add(
      'insufficient_data',
      `The Entry conditions could not be evaluated on ${Math.round((unknownEntrySteps / steps.length) * 100)}% of bars for lack of data`,
    );
  }
  if (staleSteps > 0) {
    warnings.add(
      'stale_data',
      'Some bars were missing, so conditions on them were unknown on those bars',
      staleSteps,
    );
  }

  const trades: BacktestTrade[] = cycles
    .filter((c) => c.firstFill !== undefined || c.state === 'aborted')
    .map((c) => {
      let gross = ZERO;
      let net = ZERO;
      let costs = ZERO;
      for (const [id, p] of c.positions) {
        const value = p.quantity.times(mark(id) ?? ZERO);
        gross = gross.plus(p.grossCash).plus(value);
        net = net.plus(p.cash).plus(value);
        costs = costs.plus(p.commission).plus(p.slippage).plus(p.borrow);
      }
      const legs = [...c.entryLegs, ...c.exitLegs, ...c.flattenLegs]
        .filter((l) => l.filled.gt(0))
        .map((l) => ({
          legId: l.leg.id,
          legLabel: l.leg.legLabel,
          phase: l.phase,
          instrumentId: l.leg.instrumentId,
          symbol: symbol(l.leg.instrumentId),
          side: l.side,
          quantity: l.filled.toString(),
          averagePrice: l.filled.gt(0) ? l.cost.div(l.filled).toDecimalPlaces(4).toString() : null,
        }));
      const entryAt = c.events.get('entry_partial_fill');
      const status: BacktestTrade['status'] =
        c.state === 'closed' ? 'closed' : c.state === 'aborted' ? 'aborted' : 'open';
      return {
        cycle: c.no,
        status,
        entryTime: entryAt === undefined ? null : iso(entryAt),
        exitTime: status === 'closed' && c.lastFill !== undefined ? iso(c.lastFill) : null,
        legs,
        grossPnl: gross.toDecimalPlaces(2).toString(),
        costs: costs.toDecimalPlaces(2).toString(),
        netPnl: net.toDecimalPlaces(2).toString(),
        returnPct: c.entryValue.gt(0)
          ? net.div(c.entryValue).times(HUNDRED).toDecimalPlaces(2).toString()
          : null,
      };
    });

  const byInstrument = new Map<
    string,
    { gross: Decimal; net: Decimal; costs: Decimal; legs: Set<string>; fills: number }
  >();
  for (const c of cycles) {
    for (const [id, p] of c.positions) {
      const value = p.quantity.times(mark(id) ?? ZERO);
      const agg = byInstrument.get(id) ?? {
        gross: ZERO,
        net: ZERO,
        costs: ZERO,
        legs: new Set<string>(),
        fills: 0,
      };
      agg.gross = agg.gross.plus(p.grossCash).plus(value);
      agg.net = agg.net.plus(p.cash).plus(value);
      agg.costs = agg.costs.plus(p.commission).plus(p.slippage).plus(p.borrow);
      byInstrument.set(id, agg);
    }
  }
  for (const f of fills) {
    const agg = byInstrument.get(f.instrumentId);
    if (!agg) continue;
    agg.fills += 1;
    if (f.phase !== 'flatten') agg.legs.add(f.legLabel);
  }
  const contributions: InstrumentContribution[] = [...byInstrument].map(([id, a]) => ({
    instrumentId: id,
    symbol: symbol(id),
    legs: [...a.legs],
    grossPnl: a.gross.toDecimalPlaces(2).toString(),
    costs: a.costs.toDecimalPlaces(2).toString(),
    netPnl: a.net.toDecimalPlaces(2).toString(),
    fills: a.fills,
  }));

  return {
    engineVersion: ENGINE_VERSION,
    dataVersions: data.dataVersions,
    assumptions: describeAssumptions(inputs),
    sharpeMethod: SHARPE_METHOD,
    metrics: computeMetrics({
      initial,
      equity,
      trades,
      orders: submitted,
      fills: fills.length,
      commission: commissionTotal,
      slippage: slippageTotal,
      borrow: borrowTotal,
    }),
    equity,
    trades,
    fills,
    contributions,
    warnings: warnings.list(),
  };
}
