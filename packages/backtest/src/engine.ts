import {
  checkPreTradeRisk,
  atrExpr,
  atrStopHit,
  atrStopInstrument,
  atrStopLevel,
  atrStopOf,
  atrStopDistance,
  expectedMoveBand,
  expectedMoveExpr,
  expectedMoveHit,
  expectedMoveRuleOf,
  trailingPeak,
  trailingStopHit,
  trailingStopLevel,
  trailingStopRuleOf,
  exitFiresDirectly,
  newRuntimeTriggerState,
  planEntry,
  rankedLegs,
  rearmEntryTrigger,
  sizesFromAtr,
  type CycleState,
  type RuntimeTriggerState,
  riskSizingCap,
  stopCloseExpr,
  type RiskSizing,
  entryGroups,
  isTwoSided,
  type GroupKey,
  evaluateCondition,
  hasComparisons,
  planSlots,
  rankUniverse,
  scheduledPeriod,
  scheduleOf,
  selectLegs,
  slotDefinition,
  slotKey,
  slotModeOf,
  timeStopReached,
  withContext,
  EXCLUSION_LABELS,
  type Slot,
  evaluateExpr,
  nyDate,
  nextTradingDay,
  regularSession,
  relativeDelaySeconds,
  sizeOrder,
  stepTrigger,
  SUBSTITUTED_FIELDS,
  type RiskCheckCode,
  type SizingSkip,
  type TriggerState,
  type OrderSide,
  type PhaseEvent,
  type PhaseName,
  type PlannedOrder,
  type SeriesResolver,
  type StrategyDefinition,
  withPositions,
} from '@tm/domain';
import Decimal from 'decimal.js';
import {
  seriesExprs,
  seriesKey,
  watchOnlyInstruments,
  strategyInstruments,
  type InstrumentRef,
  type LoadedData,
} from './data';
import { quoteFill, stopReached, volumeCap, type Direction } from './fills';
import { ConditionRecorder, whyNotFired } from './explain';
import { describeAssumptions, type BacktestInputs } from './inputs';
import { MarketView } from './market';
import { describeCoverage, optionsCoverage } from './options-coverage';
import { describeEarningsCoverage } from './events-coverage';
import { computeMetrics } from './metrics';
import {
  ENGINE_VERSION,
  SHARPE_METHOD,
  type BacktestFill,
  type BacktestOrder,
  type BacktestResult,
  type BacktestTrade,
  type CycleDetail,
  type EquityPoint,
  type InstrumentContribution,
  type SelectionLog,
  type SelectionRound,
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

const SIZING_MESSAGES: Record<SizingSkip, string> = {
  no_price: 'Some orders were skipped because there was no price yet',
  no_stop_distance: 'Risk-sized orders were skipped because the stop was at the current price',
  nothing_to_close: 'Some Exit legs had no position left to close',
  zero_quantity: 'Some orders were skipped because their quantity rounded to zero',
  no_atr: 'Some risk-sized entries were skipped because the ATR had too little history',
};
const RISK_MESSAGES: Record<RiskCheckCode, string> = {
  risk_active_orders: 'Orders were rejected by the maximum active orders limit',
  risk_order_size: 'Orders were rejected by the maximum order size',
  risk_exposure: 'Orders were rejected by the maximum strategy exposure',
  buying_power: 'Orders were rejected for lack of buying power (no leverage)',
  risk_daily_loss: 'New entries stopped for the day after the daily loss limit was hit',
  risk_drawdown: 'New entries stopped after the maximum drawdown was hit',
  risk_open_positions: 'Orders were rejected by the maximum instruments held',
  risk_collar: 'Limit orders were rejected by the price collar',
  stale_data: 'Orders were rejected because the price was stale',
  market_closed: 'Orders were canceled because the market was closed',
};
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
  cycle: Cycle;
  phase: PhaseName | 'flatten';
  side: OrderSide;
  status: LegStatus;
  order?: Order;
  quantity: Decimal;
  filled: Decimal;
  cost: Decimal;
  submittedAt?: number;
  filledAt?: number;
  /** For the order report: why it ended, with the figures behind it. */
  reason?: string;
  detail: Record<string, string>;
  decidedAt?: number;
  endedAt?: number;
  reference?: Decimal;
  limit?: Decimal | undefined;
  stop?: Decimal | undefined;
  /** Lowest low (buy) or highest high (sell) over the bars it worked. */
  bestPrice?: Decimal;
  barsWorking: number;
  fillCount: number;
  /** Risk-based sizing (v1.2 item 9): how the quantity was worked out. */
  sizing?: RiskSizing;
}

interface CyclePosition {
  quantity: Decimal;
  /** Cash flows at actual prices (net) and before slippage (gross). */
  cash: Decimal;
  grossCash: Decimal;
  commission: Decimal;
  slippage: Decimal;
  borrow: Decimal;
  /** Entry fills only, for the average entry price that position values use. */
  entryQuantity: Decimal;
  entryCost: Decimal;
}

interface Cycle {
  no: number;
  /** What this cycle runs: the strategy, or a slot's definition (v1.2). */
  def: StrategyDefinition;
  /** The universe member or leg this cycle holds, for Selection groups and per-leg conditions. */
  slot?: Slot;
  /** The entry group that opened it (v1.2 item 8); null for the strategy's own Entry. */
  group: GroupKey;
  /** Why the cycle exited, when v1.2 exit reasons apply. */
  exitReason?:
    'condition' | 'rebalance' | 'time_stop' | 'atr_stop' | 'expected_move' | 'trailing_stop';
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
  /** ATR stop (v1.2 item 9): the ATR when Entry was decided, and the level once filled. */
  atrAtEntry?: Decimal;
  /** Expected-move exit (ADR 0053): the move captured at entry, and the band once filled. */
  moveAtEntry?: Decimal;
  /** Trailing stop (ADR 0059): the best daily close since Entry filled, from the entry price. */
  trailPeak?: Decimal;
  /** The trailing stop's last check, for the cycle card (N166). */
  trail?: {
    percent: string;
    long: boolean;
    entryPrice: Decimal;
    peak: Decimal;
    level: Decimal;
    close: Decimal;
    time: number;
    checks: number;
    hit: boolean;
  };
  expectedMove?: {
    movePct: Decimal;
    multiple: string;
    horizon: 1 | 5;
    side: 'either' | 'gain' | 'loss';
    entryPrice: Decimal;
    lower: Decimal;
    upper: Decimal;
    long: boolean;
  };
  atrStop?: {
    atr: Decimal;
    atrMultiple: string;
    entryPrice: Decimal;
    level: Decimal;
    long: boolean;
  };
}

export interface SimulationInput {
  definition: StrategyDefinition;
  instruments: ReadonlyMap<string, InstrumentRef>;
  inputs: BacktestInputs;
  data: LoadedData;
  /** A Selection group's universe, resolved to instrument ids (v1.2 item 1). */
  members?: readonly string[];
}

/** Rounds of a selection log kept in a result, so results stay small. */
export const MAX_SELECTION_ROUNDS = 400;

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
const dec = (d: Decimal | undefined, places = 4) =>
  d === undefined ? null : d.toDecimalPlaces(places).toString();

function legOrderFor(def: StrategyDefinition, phase: PhaseName): PlannedOrder[] {
  const orders = def[phase].orders;
  if (def.execution.multiLegPolicy === 'concurrent' || !def.execution.legOrder) return orders;
  const rank = new Map(def.execution.legOrder.map((id, i) => [id, i]));
  return [...orders].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function simulate({
  definition: def,
  instruments,
  inputs,
  data,
  members = [],
}: SimulationInput): BacktestResult {
  const warnings = new Warnings();
  const mode = slotModeOf(def);
  const frequency = scheduleOf(def);
  /** v1.2 features in use: results then say why each cycle exited. */
  const v12 = mode !== 'none' || frequency !== 'daily' || (def.exit.rules?.length ?? 0) > 0;
  for (const w of data.warnings) warnings.add(`data:${w}`, w);
  const watchOnly = watchOnlyInstruments(instruments);
  const view = new MarketView(data.series, watchOnly, data.fundamentals, data.options, data.events);
  const ex = def.execution;
  const risk = def.risk;
  const slippageBps = new Decimal(inputs.slippageBps);
  const perShare = new Decimal(inputs.commissionPerShare);
  const minCommission = new Decimal(inputs.commissionMin);
  const maxVolumePct = new Decimal(inputs.maxVolumePct);
  const borrowRate = new Decimal(inputs.borrowRatePct).div(100).div(252);
  const initial = new Decimal(inputs.initialCapital);

  const allSeries = seriesExprs(def, members);
  if (allSeries.some((e) => SUBSTITUTED_FIELDS.includes(e.field))) {
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
  const usedInstruments = new Set<string>(strategyInstruments(def, members));
  const symbol = (id: string) => instruments.get(id)?.symbol ?? '?';
  const lot = (id: string) => new Decimal(instruments.get(id)?.lotSize ?? '1');

  // The clock: every execution bar end inside the requested dates.
  const stepSet = new Set<number>();
  for (const id of usedInstruments) {
    // An index is only watched: its bars never set the clock (v1.2 item 5).
    if (watchOnly.has(id)) continue;
    for (const bar of data.series.get(execKey(id)) ?? []) {
      const day = nyDate(bar.start);
      if (day >= inputs.from && day <= inputs.to) stepSet.add(Date.parse(bar.end));
    }
  }
  const steps = [...stepSet].sort((a, b) => a - b);
  if (steps.length === 0) warnings.add('no_bars', 'There are no bars in the selected dates');
  // Options metrics read end-of-day signals: say how many bars had one (options brief v2 §5.3).
  if (data.options && steps.length > 0)
    for (const c of optionsCoverage(steps, data.options, symbol))
      warnings.add(`options_coverage:${c.instrumentId}`, describeCoverage(c));
  // Earnings metrics read the latest release: say how many bars had one (ADR 0058).
  if (data.events && steps.length > 0)
    for (const c of describeEarningsCoverage(steps, data.events, symbol))
      warnings.add(`earnings_coverage:${c.instrumentId}`, c.text);

  let cash = initial;
  const portfolio = new Map<string, Decimal>();
  const cycles: Cycle[] = [];
  const orders: Order[] = [];
  const fills: BacktestFill[] = [];
  const equity: EquityPoint[] = [];
  const allLegs: LegState[] = [];
  const entryConditions = new ConditionRecorder(def.entry.condition, def.entry.trigger);
  const exitConditions = new ConditionRecorder(def.exit.condition, def.exit.trigger);
  /** Entry groups (v1.2 item 8): the strategy's own first, then each of `groups`. */
  const twoSided = isTwoSided(def);
  const groups = entryGroups(def).map((g) => ({
    ...g,
    /** The Entry trigger and the timed legs it used, as the paper runtime keeps them. */
    entry: newRuntimeTriggerState() as RuntimeTriggerState,
    entryRec:
      g.key === null
        ? entryConditions
        : new ConditionRecorder(g.definition.entry.condition, g.definition.entry.trigger),
    exitRec:
      g.key === null
        ? exitConditions
        : new ConditionRecorder(g.definition.exit.condition, g.definition.exit.trigger),
  }));
  const ownGroup = groups[0];
  if (!ownGroup) throw new Error('A strategy always has its own entry group');
  const groupOf = (c: Cycle) => groups.find((g) => g.key === c.group) ?? ownGroup;
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
        entryQuantity: ZERO,
        entryCost: ZERO,
      };
      c.positions.set(id, p);
    }
    return p;
  };

  /** The market view plus this cycle's positions, for Exit rules and Exit order prices. */
  const cycleView = (c: Cycle): SeriesResolver => {
    const r = withPositions(view, (id) => {
      const p = c.positions.get(id);
      if (!p || p.entryQuantity.isZero()) return undefined;
      return { quantity: p.quantity, averagePrice: p.entryCost.div(p.entryQuantity) };
    });
    // A slot's rules read "this instrument" as the slot's own (v1.2).
    return c.slot ? withContext(r, c.slot.instrumentId) : r;
  };

  // ---------------------------------------------------------------------------
  // Orders

  function endLeg(
    leg: LegState,
    status: LegStatus,
    now: number,
    code?: string,
    message?: string,
    detail: Record<string, string> = {},
  ) {
    if (TERMINAL.includes(leg.status)) return;
    leg.status = leg.filled.gt(0) && status !== 'filled' ? 'partial' : status;
    if (code && message) warnings.add(code, message);
    if (code) {
      leg.reason = code;
      leg.detail = detail;
    }
    leg.endedAt = now;
    if (leg.status === 'filled') leg.filledAt = now;
  }

  /** Reacts to a leg that ended without filling fully, per the multi-leg policy (§6.7). */
  function onLegProblem(c: Cycle, leg: LegState, now: number) {
    if (leg.phase === 'flatten') return;
    const phaseLegs = leg.phase === 'entry' ? c.entryLegs : c.exitLegs;
    if (c.def[leg.phase].orders.length < 2) return;
    warnings.add('leg_failed', 'A leg of a multi-leg plan did not fill completely in time');
    if (ex.onLegFailure === 'leave_and_alert') return;
    const because = { leg: leg.leg.legLabel };
    for (const other of phaseLegs) {
      if (other === leg) continue;
      if (other.status === 'waiting' || other.status === 'working')
        endLeg(other, 'canceled', now, 'other_leg_failed', undefined, because);
    }
    if (ex.onLegFailure === 'flatten_filled') flatten(c, now);
  }

  function flatten(c: Cycle, now: number) {
    for (const [id, p] of c.positions) {
      if (p.quantity.isZero()) continue;
      const side: OrderSide = p.quantity.gt(0) ? 'sell' : 'buy_to_cover';
      const leg: LegState = {
        cycle: c,
        detail: {},
        barsWorking: 0,
        fillCount: 0,
        decidedAt: now,
        leg: {
          id: `flatten-${id}`,
          legLabel: `Close ${symbol(id)}`,
          instrumentId: id,
          accountId: '',
          side,
          quantity: { type: 'units', value: p.quantity.abs().toString(), rounding: 'down' },
          orderType: 'market',
          timeInForce: 'day',
          timing: { mode: 'immediate' },
        },
        phase: 'flatten',
        side,
        status: 'waiting',
        quantity: p.quantity.abs(),
        filled: ZERO,
        cost: ZERO,
      };
      c.flattenLegs.push(leg);
      allLegs.push(leg);
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
    leg.reference = order.reference;
    leg.limit = prices.limit;
    leg.stop = prices.stop;
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

  const reject = (
    leg: LegState,
    now: number,
    code: string,
    message: string,
    detail: Record<string, string> = {},
  ) => {
    endLeg(leg, 'failed', now, code, message, detail);
    return false;
  };

  /** Sizes, risk-checks and places one leg (§6.6, §8.6). */
  function submitLeg(c: Cycle, leg: LegState, now: number): boolean {
    const o = leg.leg;
    leg.decidedAt = now;
    const ref = mark(o.instrumentId);
    if (!ref || ref.lte(0))
      return reject(
        leg,
        now,
        'no_price',
        'Some orders were skipped because there was no price yet',
      );
    const pos = position(c, o.instrumentId).quantity;
    const prices = cycleView(c);
    const price = (e: PlannedOrder['limitPrice']) => (e ? evaluateExpr(e, prices) : undefined);
    const limit = price(o.limitPrice);
    const stop = price(o.stopPrice);
    leg.reference = ref;
    leg.limit = limit;
    leg.stop = stop;
    if ((o.limitPrice && !limit) || (o.stopPrice && !stop)) {
      return reject(
        leg,
        now,
        'price_unavailable',
        'Some orders were skipped because their limit or stop price could not be computed',
      );
    }

    // A rebalance sells and buys on the same bar: what is being closed doesn't
    // count against buying power for the new entries (v1.2 slots only).
    const closingGross =
      mode === 'none'
        ? ZERO
        : cycles
            .filter((x) => x.state === 'exiting' && x !== c)
            .reduce((sum, x) => {
              let g = ZERO;
              for (const [id, p] of x.positions)
                g = g.plus(p.quantity.abs().times(mark(id) ?? ZERO));
              return sum.plus(g);
            }, ZERO);
    // ATR stop (v1.2 item 9): the ATR as of the bar Entry is decided on.
    const stopDistance = leg.phase === 'entry' ? atrStopDistance(c.def) : undefined;
    if (stopDistance && c.atrAtEntry === undefined) {
      const instrument = atrStopInstrument(c.def);
      const atr = instrument
        ? evaluateExpr(atrExpr(instrument, stopDistance.atrPeriod, inputs.adjustment), view)
        : undefined;
      if (atr) c.atrAtEntry = atr;
      else
        warnings.add(
          'atr_stop_unset',
          'Some positions had no ATR stop because the ATR had too little history at entry',
        );
    }
    // Expected-move exit (ADR 0053): the options signal as of the bar Entry is decided on.
    const moveRule = leg.phase === 'entry' ? expectedMoveRuleOf(c.def) : undefined;
    if (moveRule && c.moveAtEntry === undefined) {
      const instrument = atrStopInstrument(c.def);
      const move = instrument
        ? evaluateExpr(expectedMoveExpr(instrument, moveRule.horizon), view)
        : undefined;
      if (move && move.gt(0)) c.moveAtEntry = move;
      else
        warnings.add(
          'expected_move_unset',
          'Some positions had no expected-move exit because no options signal was recorded at entry',
        );
    }
    // Risk-based sizing (v1.2 item 9) is capped to the limits, never past them.
    // The Entry's one risk distance (ADR 0049).
    const riskDistance = sizesFromAtr(o) ? c.def.entry.risk : undefined;
    const sized = sizeOrder({
      order: o,
      referencePrice: ref,
      stopPrice: stop,
      equity: equityNow(),
      position: pos,
      lotSize: lot(o.instrumentId),
      ...(riskDistance && leg.phase === 'entry'
        ? {
            atr: evaluateExpr(
              atrExpr(o.instrumentId, riskDistance.atrPeriod, inputs.adjustment),
              view,
            ),
            distance: riskDistance,
            cap: riskSizingCap(risk, equityNow(), positionValue().gross.minus(closingGross)),
          }
        : {}),
    });
    if (sized.sizing) leg.sizing = sized.sizing;
    if (!sized.ok) {
      if (sized.code === 'no_stop_distance')
        return reject(leg, now, sized.code, SIZING_MESSAGES[sized.code]);
      endLeg(leg, 'skipped', now, sized.code, SIZING_MESSAGES[sized.code]);
      return false;
    }
    const { quantity: qty, direction, closing } = sized;
    leg.quantity = qty;

    // Pre-trade risk checks (§8.6), shared with paper execution.
    const checked = checkPreTradeRisk({
      risk,
      closing,
      quantity: qty,
      referencePrice: ref,
      limitPrice: limit,
      activeOrders: working().length,
      grossExposure: positionValue().gross.minus(closingGross),
      equity: equityNow(),
      dailyLossHit: dailyHalt,
      drawdownHit: drawdownHalt,
      openPositions: [...portfolio.values()].filter((q) => !q.isZero()).length,
      instrumentHeld: !(portfolio.get(o.instrumentId) ?? ZERO).isZero(),
    });
    if (!checked.ok && checked.code) {
      const failed = checked.checks.find((x) => !x.passed);
      const detail: Record<string, string> = {};
      if (failed?.limit !== undefined) detail.limit = failed.limit;
      if (failed?.value !== undefined) detail.value = failed.value;
      return reject(leg, now, checked.code, RISK_MESSAGES[checked.code], detail);
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
    leg.fillCount += 1;
    c.firstFill ??= at;
    c.lastFill = at;
    if (leg.phase === 'entry') {
      p.entryQuantity = p.entryQuantity.plus(qty);
      p.entryCost = p.entryCost.plus(price.times(qty));
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
    leg.barsWorking += 1;
    const best = order.direction === 'buy' ? bar.low : bar.high;
    if (
      !leg.bestPrice ||
      (order.direction === 'buy' ? best.lt(leg.bestPrice) : best.gt(leg.bestPrice))
    )
      leg.bestPrice = best;
    const quote = quoteFill(order, bar, slippageBps);
    if (!quote) {
      if (stopReached(order, bar)) order.stopTriggered = true;
    } else {
      order.stopTriggered = quote.stopTriggered;
      const collar = risk.priceCollarPct ? new Decimal(risk.priceCollarPct) : undefined;
      const marketable = order.type === 'market' || order.type === 'stop';
      const movePct = order.reference.gt(0)
        ? quote.base.minus(order.reference).abs().div(order.reference).times(100)
        : ZERO;
      if (collar && marketable && !order.closing && order.reference.gt(0) && movePct.gt(collar)) {
        endLeg(
          leg,
          'canceled',
          now,
          'collar_cancel',
          'Orders were canceled because the price moved beyond the price collar',
          {
            reference: order.reference.toDecimalPlaces(4).toString(),
            price: quote.base.toDecimalPlaces(4).toString(),
            movePct: movePct.toDecimalPlaces(2).toString(),
            limitPct: collar.toString(),
          },
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

  /** What the shared entry decision needs to know about a cycle. */
  const CYCLE_STATUS = {
    entering: 'entry_working',
    open: 'open',
    exiting: 'exit_working',
    closed: 'closed',
    aborted: 'aborted',
  } as const;
  const cycleStateOf = (c: Cycle): CycleState => ({
    status: CYCLE_STATUS[c.state],
    entryTriggeredAt: c.entryTriggeredAt,
    entryBatches: c.entries,
    exitRound: 1,
    skipped: [],
    flattened: false,
    exitTrigger: c.exitTrigger,
  });

  function newCycle(
    now: number,
    triggered: boolean,
    slot?: Slot,
    count = 1,
    group: GroupKey = null,
  ): Cycle {
    const c: Cycle = {
      no: cycles.length + 1,
      def: slot
        ? slotDefinition(def, slot, count)
        : (groups.find((g) => g.key === group)?.definition ?? def),
      ...(slot ? { slot } : {}),
      group,
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

  const legState = (c: Cycle, leg: PlannedOrder, phase: PhaseName): LegState => {
    const s: LegState = {
      leg,
      cycle: c,
      phase,
      side: leg.side,
      status: 'waiting',
      quantity: ZERO,
      filled: ZERO,
      cost: ZERO,
      detail: {},
      barsWorking: 0,
      fillCount: 0,
    };
    allLegs.push(s);
    return s;
  };
  const exitLegsFor = (c: Cycle) => legOrderFor(c.def, 'exit').map((l) => legState(c, l, 'exit'));

  function addEntryBatch(c: Cycle) {
    c.entries += 1;
    c.entryLegs.push(...legOrderFor(c.def, 'entry').map((l) => legState(c, l, 'entry')));
  }

  /** Whether a cycle's ATR stop fires on the current daily close (v1.2 item 9). */
  function checkAtrStop(c: Cycle): boolean {
    const rule = atrStopDistance(c.def);
    const instrument = atrStopInstrument(c.def);
    if (!rule || !instrument || !c.atrAtEntry) return false;
    const p = c.positions.get(instrument);
    if (!p || p.entryQuantity.isZero() || p.quantity.isZero()) return false;
    const long = p.quantity.gt(0);
    if (!c.atrStop) {
      const entryPrice = p.entryCost.div(p.entryQuantity);
      c.atrStop = {
        atr: c.atrAtEntry,
        atrMultiple: rule.atrMultiple,
        entryPrice,
        level: atrStopLevel(entryPrice, c.atrAtEntry, rule.atrMultiple, long),
        long,
      };
    }
    const close = evaluateExpr(stopCloseExpr(instrument, inputs.adjustment), view);
    return close !== undefined && atrStopHit(close, c.atrStop.level, long);
  }

  /** Whether a daily close has moved beyond the expected move captured at entry (ADR 0053). */
  function checkExpectedMove(c: Cycle): boolean {
    const rule = expectedMoveRuleOf(c.def);
    const instrument = atrStopInstrument(c.def);
    if (!rule || !instrument || !c.moveAtEntry) return false;
    const p = c.positions.get(instrument);
    if (!p || p.entryQuantity.isZero() || p.quantity.isZero()) return false;
    const long = p.quantity.gt(0);
    if (!c.expectedMove) {
      const entryPrice = p.entryCost.div(p.entryQuantity);
      c.expectedMove = {
        movePct: c.moveAtEntry,
        multiple: rule.multiple,
        horizon: rule.horizon,
        side: rule.side,
        entryPrice,
        ...expectedMoveBand(entryPrice, c.moveAtEntry, rule.multiple),
        long,
      };
    }
    const close = evaluateExpr(stopCloseExpr(instrument, inputs.adjustment), view);
    return close !== undefined && expectedMoveHit(close, c.expectedMove, rule.side, long);
  }

  /** Whether a daily close is more than the trailing percent off the best close since entry (ADR 0059). */
  function checkTrailingStop(c: Cycle, now: number): boolean {
    const rule = trailingStopRuleOf(c.def);
    const instrument = atrStopInstrument(c.def);
    if (!rule || !instrument) return false;
    const p = c.positions.get(instrument);
    if (!p || p.entryQuantity.isZero() || p.quantity.isZero()) return false;
    const long = p.quantity.gt(0);
    const close = evaluateExpr(stopCloseExpr(instrument, inputs.adjustment), view);
    if (close === undefined) return false;
    const entryPrice = p.entryCost.div(p.entryQuantity);
    const start = c.trailPeak ?? entryPrice;
    // The level is from the peak before this close; then the close may raise the peak.
    const level = trailingStopLevel(start, rule.percent, long);
    const hit = trailingStopHit(close, level, long);
    c.trailPeak = trailingPeak(start, close, long);
    c.trail = {
      percent: rule.percent,
      long,
      entryPrice,
      peak: start,
      level,
      close,
      time: now,
      checks: (c.trail?.checks ?? 0) + 1,
      hit,
    };
    return hit;
  }

  /** Starts a cycle's Exit now, for a reason other than its Exit condition. */
  function forceExit(
    c: Cycle,
    now: number,
    reason: 'rebalance' | 'time_stop' | 'atr_stop' | 'expected_move' | 'trailing_stop',
  ) {
    c.state = 'exiting';
    c.exitReason = reason;
    c.legEvents.set('exit:trigger', now);
    if (c.exitLegs.length === 0) c.exitLegs = exitLegsFor(c);
  }

  // Selection groups and per-leg conditions (v1.2 items 1, 2): the log of each evaluation.
  const selectionRounds: SelectionRound[] = [];
  let roundsDropped = 0;
  let lastPeriod: string | undefined;
  let entryEvaluations = 0;
  const template = def.entry.orders[0];
  const excludedNoValue = new Set<string>();

  function timingDue(c: Cycle, s: LegState, triggeredAt: number | undefined, now: number): boolean {
    const t = s.leg.timing;
    const needsTrigger = t.mode === 'immediate' || !c.def.execution.timingOnly;
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
          onCycleEnded(c);
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
        onCycleEnded(c);
        return;
      }
      if (c.state === 'exiting' && exitDone && flattenDone) {
        // Something is still held: watch the Exit conditions again.
        warnings.add(
          'exit_incomplete',
          'Some cycles still held positions after their Exit legs finished',
        );
        c.state = 'open';
        c.exitLegs = exitLegsFor(c);
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
      onCycleEnded(c);
    }
  }

  /** A cycle closed or was aborted: its group's Entry trigger re-arms (ADR 0049). */
  function onCycleEnded(c: Cycle) {
    if (!c.slot) rearmEntryTrigger(groupOf(c).entry.entryTrigger);
  }

  /** One evaluation of a Selection group or per-leg conditions (v1.2 items 1, 2). */
  function selectSlots(now: number, period: string) {
    if (mode === 'none') return;
    const halted = dailyHalt || drawdownHalt;
    let candidates: Slot[] = [];
    let count = 1;
    const round: SelectionRound = { time: iso(now), period, rows: [], entered: [], exited: [] };
    if (mode === 'selection' && def.entry.selection && template) {
      // A strategy-level Entry condition gates the whole selection (a regime filter).
      const gate = hasComparisons(def.entry.condition)
        ? evaluateCondition(def.entry.condition, view)
        : true;
      if (hasComparisons(def.entry.condition)) {
        const row = entryConditions.record(iso(now), view);
        if (gate === true) entryConditions.markFired(row, 'fired');
      }
      const ranking = rankUniverse(def.entry.selection, members, view, symbol);
      count = ranking.count;
      round.gate = gate ?? null;
      round.rows = ranking.rows.map((r) => [
        r.symbol,
        r.value,
        r.filter,
        r.rank,
        r.selected && gate === true,
        r.excluded,
      ]);
      for (const r of ranking.rows)
        if (r.excluded === 'no_value') excludedNoValue.add(r.instrumentId);
      if (gate === true)
        candidates = ranking.selected.map((instrumentId) => ({ legId: template.id, instrumentId }));
    } else {
      const legs = selectLegs(def, view, symbol);
      round.rows = legs.rows.map((r) => [r.symbol, r.value, r.passed, null, r.selected, null]);
      candidates = legs.selected;
      if (hasComparisons(def.entry.condition)) entryConditions.record(iso(now), view);
    }
    const held = activeCycles()
      .filter((c) => c.slot)
      .map((c) => ({ key: slotKey(c.slot as Slot), id: String(c.no), open: c.state === 'open' }));
    const plan = planSlots({
      mode,
      scheduled: frequency !== 'daily',
      candidates,
      held,
      halted,
      keepHoldings: def.entry.selection?.keepHoldings === true,
    });
    for (const id of plan.exit) {
      const c = cycles[Number(id) - 1];
      if (!c) continue;
      forceExit(c, now, 'rebalance');
      round.exited.push(symbol(c.slot?.instrumentId ?? ''));
    }
    for (const slot of plan.enter) {
      newCycle(now, true, slot, count);
      round.entered.push(symbol(slot.instrumentId));
    }
    if (halted && candidates.length > 0) round.halted = true;
    // Keep scheduled evaluations and the ones that traded; daily no-change rounds are many.
    const keep =
      frequency !== 'daily' ||
      selectionRounds.length === 0 ||
      round.entered.length > 0 ||
      round.exited.length > 0;
    if (!keep) return;
    if (selectionRounds.length >= MAX_SELECTION_ROUNDS) roundsDropped += 1;
    else selectionRounds.push(round);
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
      const multiLeg = phase !== 'flatten' && order.cycle.def[phase].orders.length > 1;
      if (multiLeg && now - order.activeFrom > ex.legTimeoutSec * 1000) {
        endLeg(
          order.leg,
          'canceled',
          now,
          'leg_timeout',
          'Legs were canceled after the leg timeout',
          { timeoutSec: String(ex.legTimeoutSec) },
        );
        onLegProblem(order.cycle, order.leg, now);
      }
    }
    for (const c of activeCycles()) settle(c, now);

    // 4. Conditions on closed bars, then due legs.
    if (
      [...usedInstruments].some(
        (id) => view.latest(execKey(id)) && allSeries.some((e) => view.isStale(e)),
      )
    ) {
      staleSteps += 1;
    }
    // The schedule gates Entry and re-selection; Exit rules run on every bar (v1.2 item 4).
    const period = scheduledPeriod(def.schedule, now, lastPeriod);
    const evaluateEntry = period !== undefined;
    if (evaluateEntry && frequency !== 'daily') lastPeriod = period;
    if (evaluateEntry) entryEvaluations += 1;

    if (mode === 'none') {
      // The one entry decision (ADR 0049), shared with the paper runtime: the
      // Entry trigger, then a timed Entry leg that may open a cycle by itself.
      for (const g of groups) {
        const gdef = g.definition;
        const entryRow = evaluateEntry ? g.entryRec.record(iso(now), view) : undefined;
        const entryTruth = entryRow ? (entryRow.truth ?? undefined) : undefined;
        if (entryRow && entryTruth === undefined && g.key === null) unknownEntrySteps += 1;
        const before = { ...g.entry.entryTrigger };
        const active = activeCycles();
        const halted = dailyHalt || drawdownHalt;
        const planned = planEntry({
          definition: gdef,
          state: g.entry,
          active: active.map((c) => ({ id: String(c.no), cycle: cycleStateOf(c) })),
          now,
          entryTruth: entryRow ? { truth: entryTruth } : undefined,
          halted,
          severalGroups: groups.length > 1,
        });
        g.entry = planned.state;
        const d = planned.decision;
        const target =
          d.kind === 'add_batch' || d.kind === 'trigger_cycle'
            ? cycles[Number(d.cycleId) - 1]
            : undefined;
        const opened =
          d.kind === 'new_cycle' ? newCycle(now, d.triggered, undefined, 1, g.key) : target;
        if (d.kind === 'add_batch' && target) addEntryBatch(target);
        else if (d.kind === 'trigger_cycle' && target) {
          target.entryTriggeredAt = now;
          target.events.set('entry_trigger', now);
        }
        if (!entryRow) continue;
        // The cycle this firing opened, added to or triggered (N166).
        const fireOpens = !(d.kind === 'none' || (d.kind === 'new_cycle' && !d.triggered));
        if (planned.fired && !dailyHalt && !drawdownHalt && fireOpens && opened)
          entryRow.cycle = opened.no;
        if (planned.fired && dailyHalt) g.entryRec.markFired(entryRow, 'daily_loss');
        else if (planned.fired && drawdownHalt) g.entryRec.markFired(entryRow, 'drawdown');
        else if (planned.fired)
          g.entryRec.markFired(
            entryRow,
            d.kind === 'none' || (d.kind === 'new_cycle' && !d.triggered) ? 'cycle_open' : 'fired',
          );
        else if (entryTruth === true)
          entryRow.outcome = whyNotFired(before, g.entry.entryTrigger, now, gdef.entry.trigger);
      }
    } else if (evaluateEntry) {
      selectSlots(now, period);
    }

    for (const c of activeCycles()) {
      scheduleLegs(c, c.entryLegs, c.entryTriggeredAt, now);
      if (c.state === 'open') {
        const exitRec = groupOf(c).exitRec;
        const row = exitRec.record(iso(now), cycleView(c), c.no);
        const truth = row.truth ?? undefined;
        const before = { ...c.exitTrigger };
        // A slot's Exit has no trigger: it exits on any bar its condition is true (ADR 0049).
        const exitTrigger = c.def.exit.trigger;
        const fires = exitTrigger
          ? stepTrigger(c.exitTrigger, truth, now, exitTrigger)
          : exitFiresDirectly(truth);
        if (fires) {
          exitRec.markFired(row);
          c.state = 'exiting';
          if (v12) c.exitReason = 'condition';
          c.events.set('entry_trigger', c.events.get('entry_trigger') ?? now);
          c.legEvents.set('exit:trigger', now);
        } else if (truth === true && exitTrigger) {
          row.outcome = whyNotFired(before, c.exitTrigger, now, exitTrigger);
        }
        if (c.exitLegs.length === 0) c.exitLegs = exitLegsFor(c);
        // The time stop, combined with the Exit condition by OR (v1.2 item 4).
        if (c.state === 'open' && timeStopReached(c.def, c.events.get('entry_partial_fill'), now))
          forceExit(c, now, 'time_stop');
        // The ATR stop, also by OR (v1.2 item 9): a daily close beyond the level fixed at entry.
        if (c.state === 'open' && checkAtrStop(c)) forceExit(c, now, 'atr_stop');
        // The expected-move exit, also by OR (ADR 0053).
        if (c.state === 'open' && checkExpectedMove(c)) forceExit(c, now, 'expected_move');
        // The trailing stop, also by OR (ADR 0059).
        if (c.state === 'open' && checkTrailingStop(c, now)) forceExit(c, now, 'trailing_stop');
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
  if (excludedNoValue.size > 0) {
    warnings.add(
      'selection_no_value',
      `${excludedNoValue.size} universe members were left out of some rankings because their metric had no value (fewer bars than the lookback needs); see the ranking table`,
    );
  }
  if (roundsDropped > 0) {
    warnings.add(
      'selection_log_truncated',
      `The selection log keeps the first ${MAX_SELECTION_ROUNDS} evaluations; ${roundsDropped} later ones are not shown`,
    );
  }
  const evaluatedSteps = frequency === 'daily' ? steps.length : entryEvaluations;
  if (mode === 'none' && evaluatedSteps > 0 && unknownEntrySteps / evaluatedSteps > 0.2) {
    warnings.add(
      'insufficient_data',
      `The Entry conditions could not be evaluated on ${Math.round((unknownEntrySteps / evaluatedSteps) * 100)}% of bars for lack of data`,
    );
  }
  if (staleSteps > 0) {
    warnings.add(
      'stale_data',
      'Some bars were missing, so conditions on them were unknown on those bars',
      staleSteps,
    );
  }

  // Per-instrument P/L and the trailing stop's last check, for the cycle card (N166).
  const cycleDetails: CycleDetail[] = cycles
    .filter((c) => c.firstFill !== undefined)
    .map((c) => {
      const instrumentsPnl = [...c.positions].map(([id, p]) => {
        const value = p.quantity.times(mark(id) ?? ZERO);
        return {
          instrumentId: id,
          symbol: symbol(id),
          grossPnl: p.grossCash.plus(value).toDecimalPlaces(2).toString(),
          costs: p.commission.plus(p.slippage).plus(p.borrow).toDecimalPlaces(2).toString(),
          netPnl: p.cash.plus(value).toDecimalPlaces(2).toString(),
        };
      });
      const t = c.trail;
      return {
        cycle: c.no,
        instruments: instrumentsPnl,
        ...(t
          ? {
              trailingStop: {
                percent: t.percent,
                direction: t.long ? ('long' as const) : ('short' as const),
                entryPrice: t.entryPrice.toDecimalPlaces(4).toString(),
                peak: t.peak.toDecimalPlaces(4).toString(),
                level: t.level.toDecimalPlaces(4).toString(),
                close: t.close.toDecimalPlaces(4).toString(),
                time: iso(t.time),
                checks: t.checks,
                hit: t.hit,
              },
            }
          : {}),
      };
    });

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
        ...(v12 && status === 'closed' ? { exitReason: c.exitReason ?? 'condition' } : {}),
        // Two-sided strategies say which group and direction each trade took (v1.2 item 8).
        ...(twoSided ? { direction: groupOf(c).direction, group: groupOf(c).label } : {}),
        // Risk sizing and the ATR stop, so each trade can be checked by hand (v1.2 item 9).
        ...withSizing(sizingOf(c)),
        ...(c.atrStop
          ? {
              atrStop: {
                atr: c.atrStop.atr.toDecimalPlaces(4).toString(),
                atrMultiple: c.atrStop.atrMultiple,
                direction: c.atrStop.long ? ('long' as const) : ('short' as const),
                entryPrice: c.atrStop.entryPrice.toDecimalPlaces(4).toString(),
                level: c.atrStop.level.toDecimalPlaces(4).toString(),
              },
            }
          : {}),
        ...(c.expectedMove
          ? {
              expectedMove: {
                movePct: c.expectedMove.movePct.toDecimalPlaces(6).toString(),
                horizon: c.expectedMove.horizon,
                multiple: c.expectedMove.multiple,
                side: c.expectedMove.side,
                direction: c.expectedMove.long ? ('long' as const) : ('short' as const),
                entryPrice: c.expectedMove.entryPrice.toDecimalPlaces(4).toString(),
                lower: c.expectedMove.lower.toDecimalPlaces(4).toString(),
                upper: c.expectedMove.upper.toDecimalPlaces(4).toString(),
              },
            }
          : {}),
      };
    });

  /** Why a leg that was never sent stayed unsent when the test ended. */
  function unsentReason(s: LegState): string {
    const c = s.cycle;
    if (c.state === 'aborted' || c.state === 'closed') return 'not_needed';
    if (s.phase === 'exit' && c.state !== 'exiting') return 'exit_not_triggered';
    const list = s.phase === 'entry' ? c.entryLegs : s.phase === 'exit' ? c.exitLegs : [];
    const prev = list[list.indexOf(s) - 1];
    if (
      prev &&
      ((ex.multiLegPolicy === 'after_prior_fill' && prev.status !== 'filled') ||
        (ex.multiLegPolicy === 'sequential' && prev.status === 'waiting'))
    )
      return 'waiting_for_prior_leg';
    if (s.phase === 'entry' && c.entryTriggeredAt === undefined && !c.def.execution.timingOnly)
      return 'entry_not_triggered';
    return 'timing_not_due';
  }

  function orderReport(): BacktestOrder[] {
    const phaseRank = { entry: 0, exit: 1, flatten: 2 } as const;
    const ordered = allLegs
      .map((s, i) => ({ s, i }))
      .sort(
        (a, b) =>
          a.s.cycle.no - b.s.cycle.no || phaseRank[a.s.phase] - phaseRank[b.s.phase] || a.i - b.i,
      );
    return ordered.map(({ s }) => {
      let outcome: BacktestOrder['outcome'];
      let reason = s.reason ?? null;
      let detail = s.detail;
      switch (s.status) {
        case 'filled':
        case 'partial':
        case 'canceled':
        case 'skipped':
          outcome = s.status;
          break;
        case 'failed':
          outcome = 'rejected';
          break;
        case 'working': {
          outcome = 'working_at_end';
          const o = s.order;
          if (!o?.firstBarSeen) reason = 'no_bar_after';
          else if (o.type === 'limit' || (o.type === 'stop_limit' && o.stopTriggered))
            reason = 'limit_not_reached';
          else if (o.type === 'stop' || o.type === 'stop_limit') reason = 'stop_not_reached';
          else reason = 'volume_cap';
          detail = {};
          break;
        }
        case 'waiting':
          outcome = 'not_sent';
          reason = unsentReason(s);
          detail = {};
          break;
      }
      return {
        cycle: s.cycle.no,
        phase: s.phase,
        legId: s.leg.id,
        legLabel: s.leg.legLabel,
        instrumentId: s.leg.instrumentId,
        symbol: symbol(s.leg.instrumentId),
        side: s.side,
        orderType: s.leg.orderType,
        timeInForce: s.leg.timeInForce,
        outcome,
        reason,
        detail,
        decidedAt: s.decidedAt === undefined ? null : iso(s.decidedAt),
        activeFrom: s.submittedAt === undefined ? null : iso(s.submittedAt),
        endedAt: s.endedAt === undefined ? null : iso(s.endedAt),
        quantity: s.status === 'waiting' || s.quantity.isZero() ? null : s.quantity.toString(),
        limitPrice: dec(s.limit),
        stopPrice: dec(s.stop),
        referencePrice: dec(s.reference),
        filledQuantity: s.filled.toString(),
        averagePrice: s.filled.gt(0) ? dec(s.cost.div(s.filled)) : null,
        fills: s.fillCount,
        barsWorking: s.barsWorking,
        bestPrice: dec(s.bestPrice),
      };
    });
  }

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
    conditions: { entry: entryConditions.report(), exit: exitConditions.report() },
    ...(groups.length > 1
      ? {
          groupConditions: groups.slice(1).map((g) => ({
            id: g.key as string,
            label: g.label,
            direction: g.direction,
            entry: g.entryRec.report(),
            exit: g.exitRec.report(),
            legIds: [...g.definition.entry.orders, ...g.definition.exit.orders].map((o) => o.id),
          })),
        }
      : {}),
    orders: orderReport(),
    symbols: Object.fromEntries([...usedInstruments].map((id) => [id, symbol(id)])),
    engineVersion: ENGINE_VERSION,
    dataVersions: data.dataVersions,
    assumptions: [...describeAssumptions(inputs), ...shortAssumptions(), ...riskAssumptions()],
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
    ...(mode !== 'none' ? { selections: selectionLog() } : {}),
    cycles: cycleDetails,
  };

  function withSizing(sizing: RiskSizing | undefined): { sizing?: RiskSizing } {
    return sizing ? { sizing } : {};
  }

  /** The first Entry leg's risk-sizing record, if it was risk-sized. */
  function sizingOf(c: Cycle): RiskSizing | undefined {
    return c.entryLegs.find((l) => l.sizing)?.sizing;
  }

  /** What risk sizing and the ATR stop assume (v1.2 item 9). */
  function riskAssumptions(): string[] {
    const defs = groups.map((g) => g.definition);
    const sized = defs.some((d) => d.entry.orders.some((o) => sizesFromAtr(o)));
    const stopped = defs.some((d) => atrStopOf(d));
    const out: string[] = [];
    if (sized || stopped)
      out.push(
        'ATR is the average true range of daily bars on the same price basis as fills, as of the bar Entry was decided on',
      );
    if (sized)
      out.push(
        'Risk-sized quantities are floor(equity × risk % ÷ (ATR × multiple)) in whole lots, lowered to fit buying power, the maximum order size and the maximum exposure; no order is placed when that is 0 or the ATR has too little history',
      );
    if (stopped)
      out.push(
        'The ATR stop is fixed at entry (entry price ∓ multiple × ATR) and does not trail; a daily close beyond it exits at the next bar, like the other exits',
      );
    if (defs.some((d) => trailingStopRuleOf(d)))
      out.push(
        'The trailing stop starts at the entry price and follows the best daily close since entry; a daily close more than the percent below it (above it, for a short) exits at the next bar, like the other exits',
      );
    if (defs.some((d) => expectedMoveRuleOf(d)))
      out.push(
        'The expected-move exit captures the latest recorded options expected move (as of the bar Entry was decided on) and fixes the band entry × (1 ± multiple × move); a daily close beyond it exits at the next bar, like the other exits',
      );
    return out;
  }

  /** What a back test with short entries assumes (v1.2 item 8). */
  function shortAssumptions(): string[] {
    const shorted = new Set<string>();
    for (const g of groups)
      for (const o of g.definition.entry.orders)
        if (o.side === 'sell_short') shorted.add(o.instrumentId);
    if (shorted.size === 0) return [];
    const unknown = [...shorted].filter((id) => instruments.get(id)?.shortable == null);
    return [
      'Short trades make (entry price − exit price) × quantity, less costs; margin requirements, margin calls and forced buy-ins are not modelled',
      ...(unknown.length > 0
        ? [
            `Whether ${unknown.map(symbol).join(', ')} can be borrowed is unknown, so the test assumes ${unknown.length === 1 ? 'it' : 'they'} can be sold short`,
          ]
        : []),
    ];
  }

  function selectionLog(): SelectionLog {
    const ref = mode === 'selection' ? def.entry.selection?.ranking : rankedLegs(def)?.ranking;
    return {
      kind: mode === 'selection' ? 'ranking' : 'legs',
      metric: ref ? { metric: ref.metric, params: ref.params } : null,
      direction: mode === 'selection' ? (def.entry.selection?.direction ?? 'desc') : 'desc',
      schedule: frequency,
      exclusionLabels: EXCLUSION_LABELS,
      rounds: selectionRounds,
    };
  }
}
