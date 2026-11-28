import {
  COMPLETION_DAYS,
  loadData,
  machineConditionChecks,
  MarketView,
  paperEvaluationInputs,
  planMachineSeries,
  seriesKey,
  watchOnlyInstruments,
  type LoadedData,
} from '@tm/backtest';
import {
  accountExposureBook,
  idempotencyKey,
  insertCycle,
  insertTransition,
  notify,
  recordAudit,
  recordOrderIntent,
  requestCancel,
  saveCycle,
  saveRuntimeState,
  updateTransition,
  type MachineActiveTransition,
  type MachineRunState,
  type RuntimeWork,
  type Transaction,
  type TransitionOutcome,
} from '@tm/db';
import {
  activeFromFor,
  checkPreTradeRisk,
  decideDay,
  fallbackStateId,
  holdsForOpenCollar,
  machineInstruments,
  machineRiskProfile,
  machineSeries,
  machineView,
  newCycleState,
  nyDate,
  planRebalance,
  regularSessionOpenAt,
  tradingDaysBetween,
  type BrokerAdapter,
  type HistoricalDataProvider,
  type LiveQuoteProvider,
  type MachineDefinition,
  type MachineRow,
  type Quote,
  type RebalancePlan,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { equityLimits } from './equity-limits';
import { effectivePriceAgeSec } from './feed-watch';
import type { RuntimeCaches } from './runtime';

/**
 * A state-machine run on paper (state-machine brief v1.4 §2–§2.4, §2.8,
 * §2.9; ADR 0124 P3a). Each pass:
 *
 * 1. decides every daily close not yet decided, with the evaluator the back
 *    test uses. The first pass of a run decides every loaded bar from the
 *    first: that is the Start replay, and it places no orders;
 * 2. until the person confirms Start, keeps what Start would do (the replayed
 *    state and its rebalance at the latest prices) for the run view;
 * 3. once confirmed, moves holdings to the state's target: one transition at a
 *    time, sells first, buys sized from the cash they leave, with the 0.5% and
 *    5% bands; an unfinished transition gets a new round at each close for up
 *    to 5 trading days, then is stuck; a newer one supersedes it.
 */

/** The replay at Start reads from here: every bar the feed has (§2.9). */
export const MACHINE_REPLAY_FROM = '1990-01-02';
/** Closes the shared bar cache can catch up on; a longer gap reads the feed. */
const CACHE_CATCH_UP_DAYS = 2;

export interface MachinePassContext {
  work: RuntimeWork;
  quotes: LiveQuoteProvider;
  history: HistoricalDataProvider;
  now: Date;
  logger: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
  health: { feedLive?: boolean | undefined };
  caches?: RuntimeCaches | undefined;
  scope: string;
  /** The usual send path (`submit` in runtime.ts): account check, broker, audit. */
  submit: (
    tx: Transaction,
    intentId: string,
    request: Parameters<BrokerAdapter['submitOrder']>[0],
  ) => Promise<boolean>;
}

const ZERO = new Decimal(0);

export async function planMachinePass(tx: Transaction, ctx: MachinePassContext): Promise<void> {
  const { work, now } = ctx;
  const def = work.machine as MachineDefinition;
  const state = structuredClone(work.state);
  const t = now.getTime();
  const today = nyDate(now);
  const fallback = fallbackStateId(def.machine);
  if (!fallback) throw new Error('A state machine needs an unconditional last row naming a state');

  // Bars: every series the rows read, from the start of the data (§2.9, §3).
  // The shared cache keeps only the newest bars a pass needs, so the replay at
  // Start and a catch-up after the worker was away read the feed directly.
  const decidedOn = state.machine?.lastDecidedOn;
  const catchUp = !decidedOn || tradingDaysBetween(decidedOn, today) > CACHE_CATCH_UP_DAYS;
  const plans = planMachineSeries(def, {
    ...paperEvaluationInputs(today),
    ...(catchUp ? { from: decidedOn ?? MACHINE_REPLAY_FROM } : {}),
  });
  const data: LoadedData =
    ctx.caches && !catchUp
      ? await ctx.caches.bars.load({
          scope: ctx.scope,
          owner: work.id,
          history: ctx.history,
          plans,
          instruments: work.instruments,
          now,
        })
      : await loadData(ctx.history, plans, work.instruments);

  // 1. Decide every close not yet decided.
  const ends = new Set<number>();
  const keys = [
    ...machineSeries(def).map(seriesKey),
    ...machineInstruments(def).map((instrumentId) =>
      seriesKey({
        instrumentId,
        interval: '1d',
        adjustment: 'split_and_dividend',
        session: 'regular',
      }),
    ),
  ];
  for (const k of keys)
    for (const b of data.series.get(k) ?? []) {
      const end = Date.parse(b.end);
      if (end <= t) ends.add(end);
    }
  const timeline = [...ends].sort((a, b) => a - b);
  const first = timeline[0];
  if (first === undefined) {
    // No bars yet: nothing to decide, nothing to trade.
    await saveRuntimeState(tx, work.id, state, now);
    return;
  }
  const m: MachineRunState = state.machine ?? {
    start: { stateId: fallback, on: nyDate(new Date(first)) },
    switches: [],
    nextSeq: 1,
  };
  state.machine = m;
  const view = new MarketView(data.series, watchOnlyInstruments(work.instruments));
  const rows = new Map(def.machine.rows.map((r) => [r.id, r]));
  const decided: {
    on: string;
    rowId: string;
    toStateId: string;
    fromStateId: string;
    why: unknown[];
  }[] = [];
  for (const end of timeline) {
    const on = nyDate(new Date(end));
    if (m.lastDecidedOn && on <= m.lastDecidedOn) continue;
    view.advance(end);
    const v = machineView(m.start, m.switches, on, tradingDaysBetween);
    const decision = decideDay(def.machine, v, view);
    m.lastDecidedOn = on;
    if (decision.kind !== 'switch') continue;
    m.switches.push({ on, fromStateId: v.current, toStateId: decision.toStateId });
    const row = rows.get(decision.rowId);
    decided.push({
      on,
      rowId: decision.rowId,
      fromStateId: v.current,
      toStateId: decision.toStateId,
      why: whyOf(row, { view: v, resolver: view, rows }),
    });
  }
  const current = m.switches.at(-1)?.toStateId ?? m.start.stateId;

  // Marks, equity and the halts (§2.8): paper capital plus what the run's fills made.
  const quoteCache = new Map<string, Quote | undefined>();
  const quoteFor = async (id: string) => {
    if (!quoteCache.has(id)) {
      const ref = work.instruments.get(id);
      quoteCache.set(
        id,
        ref ? await ctx.quotes.latestQuote({ instrumentId: id, symbol: ref.symbol }) : undefined,
      );
    }
    return quoteCache.get(id);
  };
  const marks = new Map<string, Decimal | undefined>();
  for (const id of new Set([...work.book.positions.keys(), ...machineInstruments(def)]))
    marks.set(id, (await quoteFor(id))?.last);
  const limits = equityLimits({
    startingCapital: work.startingCapital,
    cash: work.book.cash,
    positions: work.book.positions,
    marks,
    today,
    day: state.day,
    peakEquity: state.peakEquity,
    dailyLossLimit: def.risk.dailyLossLimit,
    maxDrawdownPct: def.risk.maxDrawdownPct,
  });
  state.day = limits.day;
  state.peakEquity = limits.peakEquity;
  const cash = new Decimal(work.startingCapital).plus(work.book.cash);
  const holdings = new Map([...work.book.positions].filter(([, q]) => !q.isZero()));
  const price = (id: string) => marks.get(id);
  const lot = (id: string) => new Decimal(work.instruments.get(id)?.lotSize ?? '1');
  const planFor = (stateId: string) => {
    const s = def.machine.states.find((x) => x.id === stateId);
    return s ? planRebalance(s, holdings, cash, price, lot) : undefined;
  };
  const symbol = (id: string) => work.instruments.get(id)?.symbol ?? '?';

  // 2. Before the person confirms Start: what Start would do (§2.9).
  if (!m.confirmedAt) {
    const plan = planFor(current);
    const since = m.switches.at(-1)?.on ?? m.start.on;
    const fresh = !m.proposal || m.proposal.through !== m.lastDecidedOn;
    m.proposal = {
      through: m.lastDecidedOn ?? today,
      stateId: current,
      since,
      switches: m.switches.length,
      legs: (plan?.legs ?? [])
        .filter((l) => !l.quantity.isZero())
        .map((l) => ({
          instrumentId: l.instrumentId,
          symbol: symbol(l.instrumentId),
          side: l.quantity.isNegative() ? ('sell' as const) : ('buy' as const),
          quantity: l.quantity.abs().toString(),
        })),
      equity: (plan?.equity ?? cash).toDecimalPlaces(2).toString(),
    };
    if (fresh)
      await notify(tx, {
        userId: work.userId,
        kind: 'strategy_started',
        title: `${work.strategyName}: replay done, confirm Start`,
        body: `The replay over the loaded history ends in ${stateName(def, current)} (since ${since}). Confirm Start to place its rebalance.`,
        link: `/strategy-lab/${work.strategyId}`,
        resourceType: 'strategy_runtime',
        resourceId: work.id,
        dedupeKey: `machine_replay:${work.id}`,
      });
    await saveRuntimeState(tx, work.id, state, now);
    return;
  }

  const env: OrderEnv = {
    tx,
    ctx,
    def,
    canTrade: work.status === 'running' && !work.halted,
    cycleSeq: work.nextSeq,
    equity: limits.equity,
    gross: limits.gross,
    dailyLossHit: limits.dailyLossHit,
    drawdownHit: limits.drawdownHit,
    quoteFor,
  };

  // The Start rebalance: once, on the first pass after the confirmation.
  if (!m.startedOn) {
    m.startedOn = m.lastDecidedOn ?? today;
    const plan = planFor(current);
    if (plan && !plan.done) {
      await beginTransition(env, m, {
        kind: 'start',
        on: m.startedOn,
        fromStateId: null,
        toStateId: current,
        rowId: null,
        why: [],
        plan,
      });
    }
  } else {
    // 3. Switches decided since the last pass (normally at most one a day). After
    // a gap only the newest trades; the ones before it are recorded as superseded.
    const fresh = decided.filter((d) => !m.startedOn || d.on > m.startedOn);
    for (const [i, d] of fresh.entries()) {
      const plan = i === fresh.length - 1 ? planFor(d.toStateId) : undefined;
      await beginTransition(env, m, {
        kind: 'switch',
        on: d.on,
        fromStateId: d.fromStateId,
        toStateId: d.toStateId,
        rowId: d.rowId,
        why: d.why,
        plan,
      });
    }
  }

  // 4. Completing the active transition (§2.4).
  if (m.active) await stepActive(env, m, planFor, today);
  await saveRuntimeState(tx, work.id, state, now);
}

interface OrderEnv {
  tx: Transaction;
  ctx: MachinePassContext;
  def: MachineDefinition;
  equity: Decimal;
  gross: Decimal;
  dailyLossHit: boolean;
  drawdownHit: boolean;
  quoteFor: (id: string) => Promise<Quote | undefined>;
  /** Orders go out only while the run is running and not halted; paused runs keep deciding. */
  canTrade: boolean;
  /** The next cycle number of the run (transitions with orders each have a cycle). */
  cycleSeq: number;
}

function stateName(def: MachineDefinition, id: string): string {
  return def.machine.states.find((s) => s.id === id)?.name ?? id;
}

function whyOf(
  row: MachineRow | undefined,
  env: Parameters<typeof machineConditionChecks>[1],
): unknown[] {
  return row?.condition ? machineConditionChecks(row.condition, env) : [];
}

/** A new transition (§2.3): supersedes an unfinished one, then plans its first round. */
async function beginTransition(
  env: OrderEnv,
  m: MachineRunState,
  t: {
    kind: 'start' | 'switch';
    on: string;
    fromStateId: string | null;
    toStateId: string;
    rowId: string | null;
    why: unknown[];
    plan: RebalancePlan | undefined;
  },
) {
  const { tx, ctx } = env;
  const { work, now } = ctx;
  if (m.active) await endActive(env, m, 'superseded');
  const seq = m.nextSeq++;
  const base = {
    userId: work.userId,
    runtimeId: work.id,
    seq,
    kind: t.kind,
    decidedOn: t.on,
    fromStateId: t.fromStateId,
    toStateId: t.toStateId,
    rowId: t.rowId,
    why: t.why,
  };
  // Replaced before it could trade: decided during a gap, with a newer switch after it.
  if (!t.plan) {
    await insertTransition(tx, { ...base, outcome: 'superseded' });
    return;
  }
  // Every leg under 5% of equity: the state switches with no orders, done at once (§2.4).
  if (t.kind === 'switch' && (t.plan.underSwitchBand || t.plan.done)) {
    await insertTransition(tx, { ...base, outcome: 'switched_no_orders', completedOn: t.on });
    await announce(
      env,
      seq,
      t,
      'switched with no orders: every holding is within 5% of its target',
    );
    return;
  }
  const cycleId = await insertCycle(tx, {
    userId: work.userId,
    runtimeId: work.id,
    seq: env.cycleSeq++,
    cycle: newCycleState(now.getTime()),
    at: now,
  });
  const transitionId = await insertTransition(tx, { ...base, cycleId, outcome: 'rebalancing' });
  m.active = {
    transitionId,
    seq,
    cycleId,
    toStateId: t.toStateId,
    decidedOn: t.on,
    round: 1,
    roundOn: t.on,
    sellsPlaced: false,
    buysPlaced: false,
  };
  await announce(env, seq, t, 'rebalancing at the next open');
}

async function announce(
  env: OrderEnv,
  seq: number,
  t: { kind: 'start' | 'switch'; on: string; fromStateId: string | null; toStateId: string },
  what: string,
) {
  const { work } = env.ctx;
  const to = stateName(env.def, t.toStateId);
  await notify(env.tx, {
    userId: work.userId,
    kind: 'triggered',
    title:
      t.kind === 'start'
        ? `${work.strategyName}: started in ${to}`
        : `${work.strategyName}: ${stateName(env.def, t.fromStateId ?? '')} → ${to}`,
    body: `Decided at the close of ${t.on}; ${what}.`,
    link: `/strategy-lab/${work.strategyId}`,
    resourceType: 'strategy_runtime',
    resourceId: work.id,
    dedupeKey: `machine_transition:${work.id}:${seq}`,
  });
}

/** Closes the active transition's record and cycle; cancels what it still has working. */
async function endActive(
  env: OrderEnv,
  m: MachineRunState,
  outcome: Extract<TransitionOutcome, 'done' | 'stuck' | 'superseded'>,
  completedOn?: string,
) {
  const a = m.active;
  if (!a) return;
  const { tx, ctx } = env;
  for (const o of ctx.work.working)
    if (o.intent.cycleId === a.cycleId && !o.cancelRequested)
      await requestCancel(tx, o.intent.id, 'app', `Superseded by a newer transition`);
  await updateTransition(tx, a.transitionId, {
    outcome,
    rounds: a.round,
    ...(completedOn ? { completedOn } : {}),
  });
  const cycle = { ...newCycleState(undefined), status: 'closed' as const };
  await saveCycle(tx, a.cycleId, cycle, { closedAt: ctx.now });
  if (outcome === 'stuck') {
    await notify(tx, {
      userId: ctx.work.userId,
      kind: 'triggered',
      title: `${ctx.work.strategyName}: rebalance stuck`,
      body: `The move to ${stateName(env.def, a.toStateId)} did not finish within ${COMPLETION_DAYS} trading days. Holdings stay as they are until the next switch.`,
      link: `/orders?strategy=${ctx.work.strategyId}`,
      resourceType: 'strategy_runtime',
      resourceId: ctx.work.id,
      dedupeKey: `machine_stuck:${ctx.work.id}:${a.seq}`,
    });
    await recordAudit(tx, {
      userId: ctx.work.userId,
      actorType: 'system',
      action: 'runtime.machine_stuck',
      resourceType: 'strategy_runtime',
      resourceId: ctx.work.id,
      context: { transition: a.seq, toStateId: a.toStateId, rounds: a.round },
    });
  }
  m.active = undefined;
}

/**
 * One step of the active transition (§2.3, §2.4): wait while its orders work;
 * after the sells, place the buys from the cash they left; after a round, it is
 * done when every leg is under the band, otherwise a new round starts at the
 * next close, for up to 5 trading days after the transition day.
 */
async function stepActive(
  env: OrderEnv,
  m: MachineRunState,
  planFor: (stateId: string) => RebalancePlan | undefined,
  today: string,
) {
  const a = m.active as MachineActiveTransition;
  const { ctx } = env;
  const working = ctx.work.working.filter((o) => o.intent.cycleId === a.cycleId);
  // A leg working past its timeout is cancelled (`cancel_remaining`), and the round goes on.
  const timeout = env.def.execution.legTimeoutSec * 1000;
  for (const o of working) {
    const from = activeFromFor(o.intent.eligibleAt.getTime(), env.def.execution.marketHoursPolicy);
    if (!o.cancelRequested && from !== undefined && ctx.now.getTime() - from > timeout)
      await requestCancel(env.tx, o.intent.id, 'app', 'Leg timeout');
  }
  if (working.length > 0) return;
  const plan = planFor(a.toStateId);
  if (!plan) return;
  if (plan.done) {
    await endActive(env, m, 'done', today);
    return;
  }
  // A paused or halted run keeps its transition and trades again once it runs.
  if (!env.canTrade) return;
  if (!a.sellsPlaced) {
    a.sellsPlaced = true;
    if ((await placeLegs(env, a, plan, 'sells')) > 0) return;
  }
  if (!a.buysPlaced) {
    a.buysPlaced = true;
    if ((await placeLegs(env, a, plan, 'buys')) > 0) return;
  }
  // The round is over and the transition is not done: a new round at a later close.
  const last = m.lastDecidedOn ?? today;
  if (last <= a.roundOn) {
    await updateTransition(env.tx, a.transitionId, { outcome: 'incomplete', rounds: a.round });
    return;
  }
  if (tradingDaysBetween(a.decidedOn, last) > COMPLETION_DAYS) {
    await endActive(env, m, 'stuck');
    return;
  }
  a.round++;
  a.roundOn = last;
  a.sellsPlaced = false;
  a.buysPlaced = false;
  await updateTransition(env.tx, a.transitionId, { outcome: 'incomplete', rounds: a.round });
  await stepActive(env, m, planFor, today);
}

/**
 * The sells or the buys of one round, through the usual order path: a
 * recorded intent with its risk checks, then the broker. Buys are sized from
 * the cash on hand, in whole lots, so a buy never spends cash the sells have
 * not produced (A4). Returns how many orders went out or are waiting for the open.
 */
async function placeLegs(
  env: OrderEnv,
  a: MachineActiveTransition,
  plan: RebalancePlan,
  which: 'sells' | 'buys',
): Promise<number> {
  const { tx, ctx, def } = env;
  const { work, now } = ctx;
  const risk = machineRiskProfile(def.risk, env.equity);
  let cash = new Decimal(work.startingCapital).plus(work.book.cash);
  let gross = env.gross;
  let placed = 0;
  let active = work.working.length;
  const legs = plan.legs.filter((l) =>
    which === 'sells' ? l.quantity.isNegative() : l.quantity.gt(0),
  );
  for (const leg of legs) {
    const quote = await env.quoteFor(leg.instrumentId);
    const ref = work.instruments.get(leg.instrumentId);
    if (!quote || !ref) continue;
    const sell = leg.quantity.isNegative();
    let quantity = leg.quantity.abs();
    if (!sell) {
      const size = new Decimal(ref.lotSize);
      const affordable = cash.div(quote.last.times(size)).floor().times(size);
      quantity = Decimal.min(quantity, affordable);
      if (!quantity.gt(0)) continue;
    }
    const held = work.book.positions.get(leg.instrumentId) ?? ZERO;
    const check = checkPreTradeRisk({
      risk,
      closing: sell,
      quantity,
      referencePrice: quote.last,
      activeOrders: active,
      grossExposure: gross,
      equity: env.equity,
      dailyLossHit: env.dailyLossHit,
      drawdownHit: env.drawdownHit,
      openPositions: [...work.book.positions.values()].filter((q) => !q.isZero()).length,
      instrumentHeld: !held.isZero(),
      account: sell ? undefined : await accountExposure(env),
      priceAgeSec: quote.marketOpen
        ? effectivePriceAgeSec(quote, now, ctx.health.feedLive ?? false)
        : undefined,
      staleDataSec: def.execution.staleDataSec,
    });
    const phase = sell ? 'exit' : 'entry';
    const legId = `${a.seq}:${leg.instrumentId}`;
    const key = idempotencyKey({
      runtimeId: work.id,
      cycleId: a.cycleId,
      phase,
      legId,
      attempt: a.round,
    });
    const side = sell ? 'sell' : 'buy';
    const recorded = await recordOrderIntent(tx, work.userId, {
      runtimeId: work.id,
      strategyId: work.strategyId,
      versionId: work.versionId,
      cycleId: a.cycleId,
      phase,
      plannedOrderId: legId,
      attempt: a.round,
      legLabel: `Rebalance to ${stateName(def, a.toStateId)}: ${side} ${ref.symbol}`,
      triggerEventId: undefined,
      scheduledActionId: undefined,
      eligibleAt: now.toISOString(),
      accountId: work.accountId,
      instrumentId: leg.instrumentId,
      side,
      direction: side,
      quantity: quantity.toString(),
      orderType: 'market',
      limitPrice: undefined,
      stopPrice: undefined,
      timeInForce: 'day',
      extendedHours: false,
      referencePrice: quote.last.toString(),
      pricedByFeedId: quote.feedId,
      risk: check,
      idempotencyKey: key,
      source: 'strategy',
    });
    if (!recorded.created || recorded.state !== 'ready') continue;
    placed++;
    active++;
    const value = quantity.times(quote.last);
    if (sell) gross = gross.minus(value);
    else {
      cash = cash.minus(value);
      gross = gross.plus(value);
    }
    // Decided while the market is closed: held until the open, then released within the collar.
    if (
      holdsForOpenCollar({ side, orderType: 'market', extendedHours: false }, risk) &&
      !regularSessionOpenAt(now.getTime())
    )
      continue;
    await ctx.submit(tx, recorded.intentId, {
      clientOrderId: key,
      accountId: work.accountId,
      instrumentId: leg.instrumentId,
      symbol: quote.symbol,
      direction: side,
      short: false,
      quantity: quantity.toString(),
      orderType: 'market',
      limitPrice: undefined,
      stopPrice: undefined,
      timeInForce: 'day',
      extendedHours: false,
    });
  }
  return placed;
}

/** The account's own exposure limit (ADR 0107), checked on rebalance buys. */
async function accountExposure(env: OrderEnv) {
  const { work } = env.ctx;
  if (!work.accountMaxExposure && !work.accountPilot) return undefined;
  const book = await accountExposureBook(env.tx, work.accountId);
  let gross = book.pendingEntry;
  for (const [id, p] of book.positions) {
    const px = (await env.quoteFor(id))?.last ?? p.lastPrice;
    gross = gross.plus(p.quantity.abs().times(px));
  }
  return {
    maxExposure: work.accountMaxExposure ?? undefined,
    grossExposure: gross,
    pilot: work.accountPilot ?? undefined,
  };
}
