import {
  loadData,
  MarketView,
  planSeries,
  seriesExprs,
  watchOnlyInstruments,
  type BacktestInputs,
} from '@tm/backtest';
import { PaperBroker } from '@tm/broker';
import {
  applyBrokerUpdates,
  claimRuntimes,
  DbPaperBrokerStore,
  finishScheduled,
  getReconciledAt,
  idempotencyKey,
  insertCycle,
  intentsByClientOrderId,
  loadRuntimeWork,
  lockPaperBroker,
  markOrderFailed,
  markOrderSubmitted,
  notify,
  openIncident,
  PAPER_STARTING_CAPITAL,
  recentOrderStates,
  reconcileAccount,
  recordAudit,
  recordOrderIntent,
  recordTriggerEvent,
  releaseRuntime,
  requestCancel,
  resolveIncidentsOf,
  saveCycle,
  saveRuntimeState,
  scheduleKey,
  scheduleLeg,
  getSyncCursor,
  setSyncCursor,
  withTenant,
  type ActiveCycle,
  type Database,
  type RuntimeState,
  type RuntimeWork,
  type WorkingOrder,
  type Transaction,
  loadAccountRouting,
  type AccountRouting,
  loadRouting,
  type CredentialKey,
} from '@tm/db';
import {
  fundamentalInstruments,
  activeFromFor,
  collarBreach,
  holdsForOpenCollar,
  regularSessionOpenAt,
  sendsExtendedHours,
  BrokerRejectedError,
  BrokerUnavailableError,
  checkPreTradeRisk,
  evaluateCondition,
  evaluateExpr,
  hasComparisons,
  listMembers,
  planSlots,
  rankUniverse,
  scheduledPeriod,
  scheduleOf,
  selectionCount,
  selectLegs,
  slotDefinition,
  groupDefinition,
  atrExpr,
  atrStopHit,
  atrStopInstrument,
  atrStopLevel,
  atrStopOf,
  riskSizingCap,
  stopCloseExpr,
  newRuntimeTriggerState,
  slotKey,
  slotModeOf,
  withContext,
  type Slot,
  type StrategyDefinition,
  newCycleState,
  nyDate,
  planCycle,
  planEntry,
  quoteAgeSec,
  sizeOrder,
  walkExpressions,
  type BrokerAdapter,
  type BrokerOrderRequest,
  type BrokerOrderUpdate,
  type ConditionGroup,
  type CyclePlan,
  type HistoricalDataProvider,
  type LiveQuoteProvider,
  type PhaseName,
  type PlannedLeg,
  type PlannedOrder,
  type Quote,
  type SeriesResolver,
  type Truth,
  withPositions,
  isIndicatorOnlyClass,
} from '@tm/domain';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Logger } from 'pino';
import { demoProvider, type ProviderRegistry } from './providers';
import { accountResolver, createAccountRouter } from './account-router';
import type { BrokerRegistry } from './brokers';
import { createRoutedHistory } from './routed-history';
import { createRoutedQuotes } from './routed-quotes';
import { NO_COMPANY_FEED, type FundamentalsLoader } from './fundamentals';
import { equityLimits } from './equity-limits';

/**
 * The paper runtime (Design v1.0 §6.5–6.9, §8; ADR 0012). Each pass over a
 * leased runtime, inside its tenant and one transaction:
 *
 * 1. the paper broker works its orders against the live demo feed;
 * 2. broker updates are applied to the app's orders (§8.5);
 * 3. on a newly completed bar, the Entry and Exit conditions are evaluated
 *    with the same evaluator as the back test, and trigger events recorded;
 * 4. each active cycle is planned with `planCycle`, and due legs are sized,
 *    risk-checked immediately before submission (§8.6) and placed.
 *
 * Every decision is rebuilt from durable records, so a restart resumes without
 * placing anything twice; the idempotency key backs that up at the broker.
 */

export interface RuntimeWorkerOptions {
  db: Database;
  workerId: string;
  /** The demo feed's history as of `now`; other feeds' bars come from `providers` by route. */
  history: (now: () => Date) => HistoricalDataProvider;
  /** The built-in demo feed's prices; other providers come from `providers`. */
  quotes: (now: () => Date) => LiveQuoteProvider;
  /** Market-data providers for non-demo feeds (ADR 0016). */
  providers?: ProviderRegistry;
  /** Broker platforms for non-demo accounts (ADR 0018). */
  brokers?: BrokerRegistry;
  /** Opens stored provider credentials; only the worker has it (ADR 0015). */
  privateKey?: CredentialKey | undefined;
  now?: () => Date;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  leaseSeconds?: number;
  /** Tests only: wraps the broker the pass talks to, e.g. to inject faults. */
  wrapBroker?: (broker: BrokerAdapter) => BrokerAdapter;
  /** Point-in-time company filings, for strategies with fundamental metrics (v1.2 item 6). */
  fundamentals?: FundamentalsLoader;
}

const ZERO = new Decimal(0);

/**
 * Safety defaults (§8.5, §8.6; ADR 0014), on the runtime's clock. They are
 * constants until per-account settings arrive with Phase 4.
 */
export const SAFETY = {
  /** How often each account is reconciled against the broker. */
  reconcileEveryMs: 60_000,
  /** Rejected or failed orders in a row that pause a strategy. */
  rejectsInARow: 3,
  /** How long the broker may not answer before its strategies pause. */
  brokerDownPauseMs: 60_000,
  /** How long prices may stay stale or missing, after the staleness threshold, before a pause. */
  feedLossPauseMs: 60_000,
} as const;

/** What went wrong with the broker during a pass. */
interface PassHealth {
  brokerDown: boolean;
}

/** Bars needed for the rules, as a back-test style plan ending today. */
function evaluationInputs(now: Date): BacktestInputs {
  const today = nyDate(now);
  return {
    from: today,
    to: today,
    interval: '1d',
    adjustment: 'split_and_dividend',
  } as BacktestInputs;
}

/** Latest values of the series a condition reads, for the trigger event (§8.2). */
function leafValues(
  condition: ConditionGroup,
  view: SeriesResolver,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const e of walkExpressions(condition)) {
    if (e.kind !== 'market' && e.kind !== 'indicator' && e.kind !== 'position') continue;
    out[e.id] = evaluateExpr(e, view)?.toString() ?? null;
  }
  return out;
}

export type PassOutcome = 'lost' | 'done';

export async function runRuntimePass(
  options: RuntimeWorkerOptions,
  runtimeId: string,
  userId: string,
): Promise<PassOutcome> {
  const { db, workerId, logger } = options;
  const clock = options.now ?? (() => new Date());
  const now = clock();
  const at = () => now;
  const providers: ProviderRegistry = {
    demo: demoProvider(options.quotes, options.history),
    ...options.providers,
  };

  return withTenant(db, { userId }, async (tx) => {
    await lockPaperBroker(tx, userId);
    // Bars, like prices, come through the tenant's routes (ADR 0017).
    const history = createRoutedHistory({
      inTenant: (fn) => fn(tx),
      userId,
      now: at,
      providers,
      privateKey: options.privateKey,
    });
    // Prices come through the tenant's routes, failing over between feeds (ADR 0016).
    const quotes = createRoutedQuotes({
      tx,
      userId,
      now,
      routing: await loadRouting(tx),
      providers,
      privateKey: options.privateKey,
      logger,
    });
    const store = new DbPaperBrokerStore(tx, userId);
    const paper = new PaperBroker({ quotes, store, now: at });

    let work = await loadRuntimeWork(tx, runtimeId, workerId);
    if (!work) return 'lost';

    // Each account's orders go to its own platform: the demo one to the simulator (ADR 0018).
    const accounts = await loadAccountRouting(tx, work.accounts);
    const router = createAccountRouter({
      paper,
      resolve: accountResolver({
        tx,
        userId,
        accounts,
        paper,
        brokers: options.brokers,
        privateKey: options.privateKey,
        now: at,
      }),
    });
    const broker = options.wrapBroker ? options.wrapBroker(router) : router;

    // 1–2. Orders at the broker move on; read what happened.
    const health: PassHealth = { brokerDown: false };
    await paper.tick();
    await sendCancels(broker, work, health);
    await submitReady(tx, { work, broker, quotes, now, logger, health, accounts });
    const sync = await syncUpdates(tx, broker, work, health);
    // 3. Periodic reconciliation against the broker (§8.5).
    const healed = sync.complete ? await reconcile(tx, broker, work, now, sync.unknown, health) : 0;
    if (sync.changed || healed > 0) work = (await loadRuntimeWork(tx, runtimeId, workerId)) ?? work;

    // 4. Automatic pauses (§8.6): a broker that stops answering, prices that go stale.
    work = await watchBroker(tx, work, now, health);
    if (work.status === 'running') work = await watchFeed(tx, work, quotes, now);

    if (work.status !== 'stopped') {
      await planPass(tx, {
        work,
        broker,
        history,
        quotes,
        now,
        logger,
        health,
        accounts,
        fundamentals: options.fundamentals,
      });
      if (work.status === 'running') await watchRejects(tx, work);
    } else {
      await saveRuntimeState(tx, work.id, work.state, now);
    }
    await releaseRuntime(tx, runtimeId, workerId);
    return 'done';
  });
}

/**
 * Reads every account's new updates and applies them to the matching orders.
 * Updates for orders the app never placed are handed to reconciliation.
 */
async function syncUpdates(
  tx: Transaction,
  broker: BrokerAdapter,
  work: RuntimeWork,
  health: PassHealth,
) {
  let changed = false;
  let complete = true;
  const unknown = new Map<string, string[]>();
  for (const accountId of work.accounts) {
    let cursor = await getSyncCursor(tx, accountId);
    let done = false;
    for (let page = 0; page < 20 && !done; page++) {
      let result: Awaited<ReturnType<BrokerAdapter['updates']>>;
      try {
        result = await broker.updates(accountId, cursor);
      } catch (e) {
        if (!(e instanceof BrokerUnavailableError)) throw e;
        health.brokerDown = true;
        complete = false;
        break;
      }
      if (result.updates.length > 0) {
        const byClient = new Map<string, BrokerOrderUpdate[]>();
        for (const u of result.updates) {
          byClient.set(u.clientOrderId, [...(byClient.get(u.clientOrderId) ?? []), u]);
        }
        const intents = await intentsByClientOrderId(tx, [...byClient.keys()]);
        for (const [client, updates] of byClient) {
          const intentId = intents.get(client);
          if (!intentId) {
            unknown.set(accountId, [...(unknown.get(accountId) ?? []), client]);
            continue;
          }
          const r = await applyBrokerUpdates(tx, intentId, updates);
          if (r.applied > 0) changed = true;
        }
      }
      done = result.cursor === cursor || result.updates.length === 0;
      cursor = result.cursor;
    }
    if (!done) complete = false;
    await setSyncCursor(tx, work.userId, accountId, cursor);
  }
  return { changed, complete, unknown };
}

/** Reconciles each account that is due, or at once when the stream showed unknown orders. */
async function reconcile(
  tx: Transaction,
  broker: BrokerAdapter,
  work: RuntimeWork,
  now: Date,
  unknown: Map<string, string[]>,
  health: PassHealth,
): Promise<number> {
  let healed = 0;
  for (const accountId of work.accounts) {
    const last = await getReconciledAt(tx, accountId);
    const strangers = [...new Set(unknown.get(accountId) ?? [])];
    const due = !last || now.getTime() - last.getTime() >= SAFETY.reconcileEveryMs;
    if (!due && strangers.length === 0) continue;
    try {
      const r = await reconcileAccount(tx, broker, {
        userId: work.userId,
        accountId,
        now,
        unknownClientOrderIds: strangers,
      });
      healed += r.healed + (r.incidentId ? 1 : 0);
    } catch (e) {
      if (!(e instanceof BrokerUnavailableError)) throw e;
      health.brokerDown = true;
    }
  }
  return healed;
}

/** Pauses the runtime once the broker has not answered for a while; clears when it does. */
async function watchBroker(
  tx: Transaction,
  work: RuntimeWork,
  now: Date,
  health: PassHealth,
): Promise<RuntimeWork> {
  const t = now.getTime();
  if (!health.brokerDown) {
    if (work.state.brokerDownSince === undefined) return work;
    work.state.brokerDownSince = undefined;
    await resolveIncidentsOf(
      tx,
      work.userId,
      'broker_disconnected',
      work.id,
      'The broker is answering again',
    );
    return work;
  }
  work.state.brokerDownSince ??= t;
  if (work.status !== 'running' || t - work.state.brokerDownSince < SAFETY.brokerDownPauseMs) {
    return work;
  }
  await openIncident(tx, {
    userId: work.userId,
    kind: 'broker_disconnected',
    runtimeId: work.id,
    summary: `The paper broker has not answered for ${Math.round((t - work.state.brokerDownSince) / 1000)} seconds.`,
    pause: [work.id],
    link: `/orders?strategy=${work.strategyId}`,
  });
  return { ...work, status: 'paused' };
}

/**
 * Checks the live prices the rules depend on (§8.6): stale or missing prices
 * open an incident at once (orders are already refused by the stale-data risk
 * check) and pause the strategy if they stay that way.
 */
async function watchFeed(
  tx: Transaction,
  work: RuntimeWork,
  quotes: LiveQuoteProvider,
  now: Date,
): Promise<RuntimeWork> {
  const t = now.getTime();
  const limit = work.definition.execution.staleDataSec;
  const bad: string[] = [];
  for (const [instrumentId, ref] of work.instruments) {
    // An index has daily closes only and is never traded: no live price to watch (v1.2 item 5).
    if (isIndicatorOnlyClass(ref.assetClass)) continue;
    const q = await quotes.latestQuote({ instrumentId, symbol: ref.symbol });
    // Outside the session the last quote simply stands; that is not a feed problem.
    if (!q) bad.push(`${ref.symbol} (no price)`);
    else if (q.marketOpen && quoteAgeSec(q, now) > limit) bad.push(ref.symbol);
  }
  if (bad.length === 0) {
    if (work.state.staleSince === undefined) return work;
    work.state.staleSince = undefined;
    await resolveIncidentsOf(tx, work.userId, 'stale_data', work.id, 'Prices are current again');
    return work;
  }
  work.state.staleSince ??= t;
  const link = `/orders?strategy=${work.strategyId}`;
  await openIncident(tx, {
    userId: work.userId,
    kind: 'stale_data',
    runtimeId: work.id,
    summary: `Prices older than ${limit} seconds or missing for ${bad.join(', ')}; no new orders are sent until they are current.`,
    link,
  });
  if (t - work.state.staleSince < SAFETY.feedLossPauseMs) return work;
  await openIncident(tx, {
    userId: work.userId,
    kind: 'feed_loss',
    runtimeId: work.id,
    summary: `Live prices for ${bad.join(', ')} have been unavailable for ${Math.round((t - work.state.staleSince) / 1000)} seconds.`,
    pause: [work.id],
    link,
  });
  return { ...work, status: 'paused' };
}

/** Pauses a strategy whose last few orders were all rejected or failed (§8.6). */
async function watchRejects(tx: Transaction, work: RuntimeWork): Promise<void> {
  const states = await recentOrderStates(tx, work.id, work.activeSince, SAFETY.rejectsInARow);
  if (states.length < SAFETY.rejectsInARow) return;
  if (!states.every((s) => s === 'rejected' || s === 'failed')) return;
  await openIncident(tx, {
    userId: work.userId,
    kind: 'repeated_rejects',
    runtimeId: work.id,
    summary: `${work.strategyName} was paused after ${SAFETY.rejectsInARow} orders in a row were rejected.`,
    pause: [work.id],
    link: `/orders?strategy=${work.strategyId}`,
  });
}

/** Sends cancels the app or a person requested but the broker has not yet confirmed. */
async function sendCancels(broker: BrokerAdapter, work: RuntimeWork, health: PassHealth) {
  for (const o of work.working) {
    if (!o.cancelRequested || !o.brokerOrderId) continue;
    try {
      await broker.cancelOrder(o.intent.accountId, o.brokerOrderId);
    } catch (e) {
      if (!(e instanceof BrokerUnavailableError)) throw e;
      health.brokerDown = true;
    }
  }
}

/** The broker request for a recorded intent; the same every time it is sent. */
function requestFor(o: WorkingOrder): BrokerOrderRequest {
  const i = o.intent;
  return {
    clientOrderId: i.idempotencyKey,
    accountId: i.accountId,
    instrumentId: i.instrumentId,
    symbol: o.symbol,
    direction: i.direction as BrokerOrderRequest['direction'],
    short: i.side === 'sell_short',
    quantity: i.quantity,
    orderType: i.orderType as BrokerOrderRequest['orderType'],
    limitPrice: i.limitPrice ?? undefined,
    stopPrice: i.stopPrice ?? undefined,
    timeInForce: i.timeInForce as BrokerOrderRequest['timeInForce'],
    extendedHours: i.extendedHours,
  };
}

/**
 * Submits orders recorded as ready whose submission never completed, e.g. the
 * broker was unreachable. The same client order id means no duplicate (§8.5).
 */
async function submitReady(tx: Transaction, ctx: Omit<PassContext, 'history'>) {
  const open = regularSessionOpenAt(ctx.now.getTime());
  const risk = ctx.work.definition.risk;
  for (const o of ctx.work.working) {
    if (o.state !== 'ready' || o.brokerOrderId || o.cancelRequested) continue;
    const i = o.intent;
    if (i.source === 'strategy' && risk.priceCollarPct && holdsForOpenCollar(i, risk)) {
      // Held for the open (see placeLeg); sent only within the collar.
      if (!open) continue;
      const quote = await ctx.quotes.latestQuote({
        instrumentId: i.instrumentId,
        symbol: o.symbol,
      });
      if (!quote) continue;
      const reference = new Decimal(i.referencePrice);
      const { movePct, breached } = collarBreach(reference, quote.last, risk.priceCollarPct);
      if (breached) {
        const opened = quote.last.toFixed(2);
        const decided = reference.toFixed(2);
        await requestCancel(
          tx,
          i.id,
          'app',
          'The price opened at ' +
            '$' +
            opened +
            ', ' +
            movePct.toFixed(1) +
            '% from ' +
            '$' +
            decided +
            ' when the order was decided. The price collar allows ' +
            risk.priceCollarPct +
            '%.',
        );
        continue;
      }
    }
    await submit(tx, ctx, i.id, requestFor(o));
  }
}

interface PassContext {
  work: RuntimeWork;
  broker: BrokerAdapter;
  history: HistoricalDataProvider;
  quotes: LiveQuoteProvider;
  now: Date;
  logger: RuntimeWorkerOptions['logger'];
  health: PassHealth;
  /** Each account's platform and capabilities (ADR 0018). */
  accounts: ReadonlyMap<string, AccountRouting>;
  fundamentals?: FundamentalsLoader | undefined;
}

async function planPass(tx: Transaction, ctx: PassContext) {
  const { work, now } = ctx;
  const def = work.definition;
  const t = now.getTime();
  const state: RuntimeState = structuredClone(work.state);

  // Marks and equity (§8.6): paper capital plus what the runtime's fills made.
  const quoteCache = new Map<string, Quote | undefined>();
  const quoteFor = async (instrumentId: string) => {
    if (!quoteCache.has(instrumentId)) {
      const ref = work.instruments.get(instrumentId);
      quoteCache.set(
        instrumentId,
        ref ? await ctx.quotes.latestQuote({ instrumentId, symbol: ref.symbol }) : undefined,
      );
    }
    return quoteCache.get(instrumentId);
  };
  const markOf = async (id: string) => (await quoteFor(id))?.last;
  const marks = new Map<string, Decimal | undefined>();
  for (const [id, q] of work.book.positions) if (!q.isZero()) marks.set(id, await markOf(id));
  const today = nyDate(now);
  const limits = equityLimits({
    startingCapital: PAPER_STARTING_CAPITAL,
    cash: work.book.cash,
    positions: work.book.positions,
    marks,
    today,
    day: state.day,
    peakEquity: state.peakEquity,
    dailyLossLimit: def.risk.dailyLossLimit,
    maxDrawdownPct: def.risk.maxDrawdownPct,
  });
  const { equity, gross, dailyLossHit, drawdownHit } = limits;
  state.day = limits.day;
  state.peakEquity = limits.peakEquity;
  const halted = work.halted || work.status !== 'running';
  if (dailyLossHit || drawdownHit) {
    // Entries stop for the day or until reviewed; Exit orders still run (§8.6).
    const limit = dailyLossHit ? 'daily loss limit' : 'maximum drawdown';
    await notify(tx, {
      userId: work.userId,
      kind: 'risk_pause',
      title: `${work.strategyName}: ${dailyLossHit ? 'Daily loss limit' : 'Maximum drawdown'} reached`,
      body: `No new Entry orders while the ${limit} is reached; Exit rules keep running.`,
      link: `/orders?strategy=${work.strategyId}`,
      resourceType: 'strategy_runtime',
      resourceId: work.id,
      dedupeKey: `${dailyLossHit ? 'daily_loss' : 'drawdown'}:${work.id}:${today}`,
    });
  }

  // 3. Conditions on the newest completed bars (§6.5).
  const mode = slotModeOf(def);
  const members = listMembers(def);
  const data = await loadData(
    ctx.history,
    planSeries(def, evaluationInputs(now), members, watchOnlyInstruments(work.instruments)),
    work.instruments,
  );
  // Fundamental metrics read company filings as known now (v1.2 item 6); without
  // them those metrics are unknown, so conditions on them don't qualify.
  const companies = fundamentalInstruments(def, members);
  if (companies.length > 0) {
    try {
      if (!ctx.fundamentals) throw new Error(NO_COMPANY_FEED);
      const loaded = await ctx.fundamentals(
        work.userId,
        companies.flatMap((id) => {
          const ref = work.instruments.get(id);
          return ref ? [{ id, symbol: ref.symbol }] : [];
        }),
      );
      data.fundamentals = loaded.byId;
    } catch (error) {
      const e = error as { name?: string; message?: string };
      ctx.logger.warn(
        { runtimeId: work.id, err: { name: e.name, message: e.message } },
        'fundamentals unavailable',
      );
    }
  }
  const view = new MarketView(
    data.series,
    watchOnlyInstruments(work.instruments),
    data.fundamentals,
  );
  view.advance(t);
  let dataTime = 0;
  for (const e of seriesExprs(def, members)) {
    const bars = data.series.get(`${e.instrumentId}|${e.interval}|${e.adjustment}|${e.session}`);
    const last = bars?.filter((b) => Date.parse(b.end) <= t).at(-1);
    if (last) dataTime = Math.max(dataTime, Date.parse(last.end));
  }
  const newData = dataTime > 0 && dataTime > (state.lastDataTime ?? 0);
  if (newData) state.lastDataTime = dataTime;
  // The schedule gates Entry and re-selection; Exit rules run on every bar (v1.2 item 4).
  const period = newData ? scheduledPeriod(def.schedule, t, state.lastSchedulePeriod) : undefined;
  const entryDue = period !== undefined;
  if (entryDue && scheduleOf(def) !== 'daily') state.lastSchedulePeriod = period;
  const evaluate = (phase: PhaseName, r: SeriesResolver = view, d = def): Truth =>
    evaluateCondition(d[phase].condition, r);
  /** The view plus a cycle's positions, for Exit rules and Exit order prices. */
  const cycleView = (c: ActiveCycle): SeriesResolver => {
    const r = withPositions(view, (id) => {
      const e = c.entries.get(id);
      if (!e || e.quantity.isZero()) return undefined;
      return { quantity: c.positions.get(id) ?? ZERO, averagePrice: e.cost.div(e.quantity) };
    });
    // A slot's rules read "this instrument" as the slot's own (v1.2).
    return c.cycle.slot ? withContext(r, c.cycle.slot.instrumentId) : r;
  };
  const symbolOf = (id: string) => work.instruments.get(id)?.symbol ?? '?';
  const count =
    mode === 'selection' && def.entry.selection
      ? selectionCount(def.entry.selection, members.length)
      : 1;
  /** What a cycle runs: the strategy, or its slot's definition. */
  const cycleDefinition = (c: ActiveCycle): StrategyDefinition =>
    c.cycle.slot
      ? slotDefinition(def, c.cycle.slot, count)
      : c.cycle.group
        ? groupDefinition(def, c.cycle.group)
        : def;
  const groupLabel = (c: { cycle: { group?: string | undefined } }) =>
    c.cycle.group ? def.groups?.find((g) => g.id === c.cycle.group)?.label : undefined;

  // Without a mark for every holding, equity is not known: no new entries this pass.
  const entryHalted = halted || dailyLossHit || drawdownHit || !limits.complete;
  const cycles: ActiveCycle[] = [...work.cycles];
  let entryTruth: { truth: Truth } | undefined;
  let entryEventId: string | undefined;
  const newCycleIds: string[] = [];
  const rebalanceExits = new Set<string>();

  const openCycle = async (
    cycle: ReturnType<typeof newCycleState>,
    triggered: boolean,
    eventId = entryEventId,
  ) => {
    const id = await insertCycle(tx, {
      userId: work.userId,
      runtimeId: work.id,
      seq: work.nextSeq,
      cycle,
      entryTriggerEventId: triggered ? eventId : undefined,
      at: now,
    });
    newCycleIds.push(id);
    cycles.push({
      id,
      seq: work.nextSeq,
      cycle,
      legs: [],
      positions: new Map(),
      cash: ZERO,
      entries: new Map(),
      entryTriggerEventId: triggered ? (eventId ?? null) : null,
      exitTriggerEventId: null,
    });
    const seq = work.nextSeq;
    work.nextSeq += 1;
    await recordAudit(tx, {
      userId: work.userId,
      actorType: 'system',
      action: 'runtime.entry_triggered',
      resourceType: 'strategy_cycle',
      resourceId: id,
      context: { runtimeId: work.id, triggerEventId: eventId ?? null },
    });
    if (triggered) {
      const label = groupLabel({ cycle });
      const what = cycle.slot
        ? ` for ${symbolOf(cycle.slot.instrumentId)}`
        : label
          ? ` (${label})`
          : '';
      await notify(tx, {
        userId: work.userId,
        kind: 'triggered',
        title: `${work.strategyName}: Entry triggered${what}`,
        body: `Cycle ${seq} started; its Entry orders follow their timing rules.`,
        link: `/orders?strategy=${work.strategyId}`,
        resourceType: 'strategy_cycle',
        resourceId: id,
        dedupeKey: `entry:${id}`,
      });
    }
    return id;
  };

  let qualified = false;
  if (mode === 'none') {
    // Entry: a new cycle, another batch, or nothing (§6.9).
    entryTruth = newData && entryDue ? { truth: evaluate('entry') } : undefined;
    const entry = planEntry({
      definition: def,
      state: state.trigger,
      active: work.cycles.map((c) => ({ id: c.id, cycle: c.cycle })),
      now: t,
      entryTruth,
      halted: entryHalted,
    });
    state.trigger = entry.state;
    // The trigger event is written after its cycle, so both can point at each other.
    entryEventId = entryTruth ? randomUUID() : undefined;
    qualified = entry.decision.kind !== 'none';
    if (entry.decision.kind === 'new_cycle') {
      await openCycle(
        newCycleState(entry.decision.triggered ? t : undefined),
        entry.decision.triggered,
      );
    } else if (entry.decision.kind === 'add_batch') {
      const target = cycles.find((c) => c.id === (entry.decision as { cycleId: string }).cycleId);
      if (target) target.cycle = { ...target.cycle, entryBatches: target.cycle.entryBatches + 1 };
    }
    // Further entry groups (v1.2 item 8), in order: one enters only while no
    // cycle of any group is open, so a position is never flipped.
    for (const g of def.groups ?? []) {
      const gdef = groupDefinition(def, g.id);
      const truth = newData && entryDue ? { truth: evaluate('entry', view, gdef) } : undefined;
      const planned = planEntry({
        definition: gdef,
        state: state.groupTriggers?.[g.id] ?? newRuntimeTriggerState(),
        active: cycles
          .filter((c) => c.cycle.status !== 'closed' && c.cycle.status !== 'aborted')
          .map((c) => ({ id: c.id, cycle: c.cycle })),
        now: t,
        entryTruth: truth,
        halted: entryHalted,
      });
      state.groupTriggers = { ...state.groupTriggers, [g.id]: planned.state };
      if (!truth) continue;
      const eventId = randomUUID();
      const opened =
        planned.decision.kind === 'new_cycle'
          ? await openCycle(
              { ...newCycleState(planned.decision.triggered ? t : undefined), group: g.id },
              planned.decision.triggered,
              eventId,
            )
          : undefined;
      await recordTriggerEvent(tx, {
        id: eventId,
        userId: work.userId,
        runtimeId: work.id,
        cycleId: opened,
        phase: 'entry',
        dataTime: new Date(dataTime),
        evaluatedAt: now,
        result: truth.truth,
        qualified: planned.decision.kind !== 'none',
        values: leafValues(gdef.entry.condition, view),
      });
    }
  } else if (entryDue) {
    // Selection groups and per-leg conditions (v1.2 items 1, 2), as the back test does.
    let candidates: Slot[] = [];
    if (mode === 'selection' && def.entry.selection) {
      const template = def.entry.orders[0];
      const gate: Truth = hasComparisons(def.entry.condition) ? evaluate('entry') : true;
      const ranking = rankUniverse(def.entry.selection, members, view, symbolOf);
      if (gate === true && template)
        candidates = ranking.selected.map((instrumentId) => ({ legId: template.id, instrumentId }));
      entryTruth = { truth: gate };
    } else {
      const legs = selectLegs(def, view, symbolOf);
      candidates = legs.selected;
      entryTruth = { truth: candidates.length > 0 };
    }
    entryEventId = randomUUID();
    const plan = planSlots({
      mode,
      scheduled: scheduleOf(def) !== 'daily',
      candidates,
      held: work.cycles
        .filter((c) => c.cycle.slot)
        .map((c) => ({
          key: slotKey(c.cycle.slot as Slot),
          id: c.id,
          open: c.cycle.status === 'open',
        })),
      halted: entryHalted,
    });
    for (const id of plan.exit) rebalanceExits.add(id);
    for (const slot of plan.enter) await openCycle({ ...newCycleState(t), slot }, true);
    qualified = plan.enter.length > 0 || plan.exit.length > 0;
  }

  if (entryTruth && entryEventId) {
    await recordTriggerEvent(tx, {
      id: entryEventId,
      userId: work.userId,
      runtimeId: work.id,
      cycleId: newCycleIds[0],
      phase: 'entry',
      dataTime: new Date(dataTime),
      evaluatedAt: now,
      result: entryTruth.truth,
      qualified,
      values: leafValues(def.entry.condition, view),
    });
  }

  // A rebalance sells and buys on the same pass: what is being closed doesn't
  // count against buying power for the new entries (v1.2, slots only).
  let closingGross = ZERO;
  if (mode !== 'none') {
    for (const c of cycles) {
      if (c.cycle.status !== 'exit_working' && !rebalanceExits.has(c.id)) continue;
      for (const [id, q] of c.positions) {
        const px = await markOf(id);
        if (px) closingGross = closingGross.plus(q.abs().times(px));
      }
    }
  }

  // 4. Plan and act on each active cycle.
  const working = () => work.working.length;
  let placedThisPass = 0;
  for (const c of cycles) {
    const cycleDef = cycleDefinition(c);
    const exitTruth =
      newData && c.cycle.status === 'open'
        ? { truth: evaluate('exit', cycleView(c), cycleDef) }
        : undefined;
    // ATR stop (v1.2 item 9): the ATR is fixed when Entry is decided; a daily
    // close beyond entry ∓ multiple × that ATR exits, by OR with the condition.
    const atrRule = atrStopOf(cycleDef);
    const atrInstrument = atrStopInstrument(cycleDef);
    if (atrRule && atrInstrument && !c.cycle.atrAtEntry) {
      const atr = evaluateExpr(atrExpr(atrInstrument, atrRule.atrPeriod), view);
      if (atr) c.cycle = { ...c.cycle, atrAtEntry: atr.toString() };
    }
    let atrStopFired = false;
    if (newData && atrRule && atrInstrument && c.cycle.atrAtEntry && c.cycle.status === 'open') {
      const entry = c.entries.get(atrInstrument);
      const held = c.positions.get(atrInstrument) ?? ZERO;
      const close = evaluateExpr(stopCloseExpr(atrInstrument), view);
      if (entry && !entry.quantity.isZero() && !held.isZero() && close) {
        const long = held.gt(0);
        const level = atrStopLevel(
          entry.cost.div(entry.quantity),
          new Decimal(c.cycle.atrAtEntry),
          atrRule.atrMultiple,
          long,
        );
        atrStopFired = atrStopHit(close, level, long);
      }
    }
    const plan = planCycle({
      definition: cycleDef,
      cycle: c.cycle,
      legs: c.legs,
      positions: c.positions,
      now: t,
      exitTruth,
      forceExit: rebalanceExits.has(c.id) ? 'rebalance' : atrStopFired ? 'atr_stop' : undefined,
    });
    let exitEventId: string | undefined;
    if (exitTruth) {
      exitEventId = await recordTriggerEvent(tx, {
        userId: work.userId,
        runtimeId: work.id,
        cycleId: c.id,
        phase: 'exit',
        dataTime: new Date(dataTime),
        evaluatedAt: now,
        result: exitTruth.truth,
        qualified: plan.notes.includes('exit_triggered'),
        values: leafValues(cycleDef.exit.condition, cycleView(c)),
      });
    }

    for (const cancel of plan.cancel) {
      const target = await requestCancel(
        tx,
        cancel.intentId,
        'app',
        cancel.reason === 'leg_timeout'
          ? 'Leg timeout reached'
          : 'Another leg of the plan did not fill',
      );
      if (target) {
        try {
          await ctx.broker.cancelOrder(target.accountId, target.brokerOrderId);
        } catch (e) {
          if (!(e instanceof BrokerUnavailableError)) throw e;
        }
      }
    }

    // While halted or paused, due legs are dropped, not held: nothing fires late (§8.1).
    const submit = halted ? [] : plan.submit;
    if (halted && plan.submit.length > 0) {
      plan.cycle.skipped = [...plan.cycle.skipped, ...plan.submit.map((l) => l.key)];
    }

    for (const leg of plan.scheduled) {
      await scheduleLeg(tx, {
        userId: work.userId,
        runtimeId: work.id,
        cycleId: c.id,
        phase: leg.phase,
        legId: leg.legId,
        attempt: leg.attempt,
        dueAt: new Date(leg.dueAt),
        referenceKind: leg.reference.kind,
        referenceId: referenceId(
          leg,
          c,
          c.cycle.group ? (c.entryTriggerEventId ?? undefined) : entryEventId,
        ),
      });
    }

    for (const leg of submit) {
      const placed = await placeLeg(tx, ctx, {
        cycle: c,
        plan,
        leg,
        quoteFor,
        view: cycleView(c),
        definition: cycleDef,
        equity,
        gross: leg.phase === 'entry' ? gross.minus(closingGross) : gross,
        dailyLossHit,
        drawdownHit,
        activeOrders: working() + placedThisPass,
        triggerEventId:
          leg.phase === 'entry'
            ? (c.entryTriggerEventId ?? undefined)
            : (exitEventId ?? c.exitTriggerEventId ?? undefined),
      });
      if (placed) placedThisPass += 1;
      await finishScheduled(
        tx,
        work.userId,
        scheduleKey(c.id, leg.phase, leg.legId, leg.attempt),
        placed === undefined ? 'canceled' : 'done',
      );
    }

    if (plan.flatten) {
      for (const [instrumentId, q] of c.positions) {
        if (q.isZero()) continue;
        await placeFlatten(tx, ctx, c, instrumentId, q, quoteFor);
      }
    }

    let realizedPnl: string | undefined;
    if (plan.cycle.status === 'closed') realizedPnl = c.cash.toDecimalPlaces(2).toString();
    await saveCycle(tx, c.id, plan.cycle, {
      ...(exitEventId && plan.notes.includes('exit_triggered')
        ? { exitTriggerEventId: exitEventId }
        : {}),
      ...(realizedPnl !== undefined ? { realizedPnl } : {}),
    });
    for (const note of plan.notes) {
      if (
        note === 'closed' ||
        note === 'aborted' ||
        note === 'position_opened' ||
        note === 'exit_triggered'
      ) {
        await recordAudit(tx, {
          userId: work.userId,
          actorType: 'system',
          action: `runtime.${note}`,
          resourceType: 'strategy_cycle',
          resourceId: c.id,
          context: { runtimeId: work.id, ...(realizedPnl ? { realizedPnl } : {}) },
        });
        if (note === 'exit_triggered') {
          await notify(tx, {
            userId: work.userId,
            kind: 'triggered',
            title: `${work.strategyName}: Exit triggered`,
            body: `Cycle ${c.seq} is exiting; its Exit orders follow their timing rules.`,
            link: `/orders?strategy=${work.strategyId}`,
            resourceType: 'strategy_cycle',
            resourceId: c.id,
            dedupeKey: `exit:${c.id}:${plan.cycle.exitRound}`,
          });
        }
      }
    }
  }

  await saveRuntimeState(tx, work.id, state, now);
}

/** The durable record a scheduled leg's timing refers to (§6.8). */
function referenceId(leg: PlannedLeg, c: ActiveCycle, entryEventId: string | undefined) {
  const r = leg.reference;
  if (r.kind === 'leg') {
    const [phase, legId, attempt] = r.legKey.split(':');
    return c.legs.find(
      (l) => l.phase === phase && l.legId === legId && String(l.attempt) === attempt,
    )?.intentId;
  }
  if (r.kind === 'event') {
    if (r.event === 'entry_trigger') return entryEventId;
    // The earliest Entry order is the durable source of the other phase events.
    return [...c.legs].filter((l) => l.phase === 'entry').sort((a, b) => a.placedAt - b.placedAt)[0]
      ?.intentId;
  }
  return undefined;
}

interface PlaceInput {
  cycle: ActiveCycle;
  plan: CyclePlan;
  leg: PlannedLeg;
  quoteFor: (instrumentId: string) => Promise<Quote | undefined>;
  view: SeriesResolver;
  /** The cycle's definition: the strategy, or its slot's (v1.2). */
  definition: StrategyDefinition;
  equity: Decimal;
  gross: Decimal;
  dailyLossHit: boolean;
  drawdownHit: boolean;
  activeOrders: number;
  triggerEventId: string | undefined;
}

/**
 * Sizes, risk-checks and submits one leg (§6.6, §8.2, §8.6). Returns true when
 * an order reached the broker, false when it was recorded but refused, and
 * undefined when the leg was skipped (nothing to trade).
 */
async function placeLeg(
  tx: Transaction,
  ctx: PassContext,
  input: PlaceInput,
): Promise<boolean | undefined> {
  const { work, now } = ctx;
  const def = input.definition;
  const { cycle: c, plan, leg } = input;
  const order = def[leg.phase].orders.find((o) => o.id === leg.legId);
  if (!order) return skip(plan, leg);
  const quote = await input.quoteFor(order.instrumentId);
  if (!quote) return skip(plan, leg);
  const price = (e: PlannedOrder['limitPrice']) => (e ? evaluateExpr(e, input.view) : undefined);
  const limit = price(order.limitPrice);
  const stop = price(order.stopPrice);
  if ((order.limitPrice && !limit) || (order.stopPrice && !stop)) return skip(plan, leg);

  // Risk-based sizing (v1.2 item 9): ATR of the daily bars now, capped to the limits.
  const atrPeriod = order.quantity.type === 'risk_atr' ? order.quantity.atrPeriod : undefined;
  const sized = sizeOrder({
    order,
    referencePrice: quote.last,
    stopPrice: stop,
    equity: input.equity,
    position: c.positions.get(order.instrumentId) ?? ZERO,
    lotSize: new Decimal(work.instruments.get(order.instrumentId)?.lotSize ?? '1'),
    ...(atrPeriod
      ? {
          atr: evaluateExpr(atrExpr(order.instrumentId, atrPeriod), input.view),
          cap: riskSizingCap(def.risk, input.equity, input.gross),
        }
      : {}),
  });
  if (atrPeriod) {
    // Kept on the cycle so the run's log says how the quantity was set, or why nothing was.
    const why = sized.ok ? undefined : sized.code;
    plan.cycle.sizing = {
      ...plan.cycle.sizing,
      [leg.legId]: { ...sized.sizing, ...(why ? { skipped: why } : {}) },
    };
    if (why)
      ctx.logger.info(
        { runtimeId: work.id, leg: leg.legId, reason: why },
        'risk-sized entry skipped',
      );
  }
  if (!sized.ok) return skip(plan, leg);

  const marketClosedCancel =
    activeFromFor(now.getTime(), def.execution.marketHoursPolicy) === undefined;
  // Under "extended hours if supported", a day limit leg on an account that
  // trades extended hours goes out now instead of waiting for the open (§6.8).
  const extendedHours = sendsExtendedHours(
    order,
    def.execution.marketHoursPolicy,
    regularSessionOpenAt(now.getTime()),
    ctx.accounts.get(order.accountId)?.capabilities.extendedHours ?? false,
  );
  const openPositions = [...work.book.positions.values()].filter((q) => !q.isZero()).length;
  let risk = checkPreTradeRisk({
    risk: def.risk,
    closing: sized.closing,
    quantity: sized.quantity,
    referencePrice: quote.last,
    limitPrice: limit,
    activeOrders: input.activeOrders,
    grossExposure: input.gross,
    equity: input.equity,
    dailyLossHit: input.dailyLossHit,
    drawdownHit: input.drawdownHit,
    openPositions,
    instrumentHeld: !(work.book.positions.get(order.instrumentId) ?? ZERO).isZero(),
    // Outside the session the last quote is old by design; orders then wait for the open.
    priceAgeSec: quote.marketOpen ? quoteAgeSec(quote, now) : undefined,
    staleDataSec: def.execution.staleDataSec,
  });
  if (risk.ok && marketClosedCancel) {
    risk = {
      ok: false,
      code: 'market_closed',
      checks: [...risk.checks, { code: 'market_closed', passed: false }],
    };
  }

  const key = idempotencyKey({
    runtimeId: work.id,
    cycleId: c.id,
    phase: leg.phase,
    legId: leg.legId,
    attempt: leg.attempt,
  });
  const recorded = await recordOrderIntent(tx, work.userId, {
    runtimeId: work.id,
    strategyId: work.strategyId,
    versionId: work.versionId,
    cycleId: c.id,
    phase: leg.phase,
    plannedOrderId: order.id,
    attempt: leg.attempt,
    legLabel: order.legLabel,
    triggerEventId: input.triggerEventId,
    scheduledActionId: undefined,
    eligibleAt: new Date(Math.max(leg.dueAt, 0) || now.getTime()).toISOString(),
    accountId: order.accountId,
    instrumentId: order.instrumentId,
    side: order.side,
    direction: sized.direction,
    quantity: sized.quantity.toString(),
    orderType: order.orderType,
    limitPrice: limit?.toString(),
    stopPrice: stop?.toString(),
    timeInForce: order.timeInForce,
    extendedHours,
    referencePrice: quote.last.toString(),
    risk,
    idempotencyKey: key,
    source: 'strategy',
  });
  if (!recorded.created || recorded.state !== 'ready') return false;
  // Decided while the market is closed: wait for the open, then check the
  // collar against the opening price, as the back test does (§7.2).
  if (
    holdsForOpenCollar({ ...order, extendedHours }, def.risk) &&
    !regularSessionOpenAt(now.getTime())
  ) {
    return true;
  }
  return submit(tx, ctx, recorded.intentId, {
    clientOrderId: key,
    accountId: order.accountId,
    instrumentId: order.instrumentId,
    symbol: quote.symbol,
    direction: sized.direction,
    short: order.side === 'sell_short',
    quantity: sized.quantity.toString(),
    orderType: order.orderType,
    limitPrice: limit?.toString(),
    stopPrice: stop?.toString(),
    timeInForce: order.timeInForce,
    extendedHours,
  });
}

function skip(plan: CyclePlan, leg: PlannedLeg): undefined {
  if (!plan.cycle.skipped.includes(leg.key)) plan.cycle.skipped.push(leg.key);
  return undefined;
}

async function submit(
  tx: Transaction,
  ctx: Pick<PassContext, 'broker' | 'work' | 'logger' | 'health'>,
  intentId: string,
  request: Parameters<BrokerAdapter['submitOrder']>[0],
): Promise<boolean> {
  try {
    const { brokerOrderId } = await ctx.broker.submitOrder(request);
    await markOrderSubmitted(tx, intentId, brokerOrderId);
    await recordAudit(tx, {
      userId: ctx.work.userId,
      actorType: 'system',
      action: 'order.submitted',
      resourceType: 'order_intent',
      resourceId: intentId,
      context: { runtimeId: ctx.work.id, brokerOrderId },
    });
    return true;
  } catch (e) {
    if (e instanceof BrokerRejectedError) {
      await markOrderFailed(tx, intentId, e.message);
      return false;
    }
    if (e instanceof BrokerUnavailableError) {
      // The intent stays ready; the next pass submits it again with the same key.
      ctx.logger.warn({ intentId }, 'broker unavailable; will retry');
      ctx.health.brokerDown = true;
      return false;
    }
    throw e;
  }
}

/** Closing orders for what a cycle still holds, after a failed multi-leg plan (§6.7). */
async function placeFlatten(
  tx: Transaction,
  ctx: PassContext,
  c: ActiveCycle,
  instrumentId: string,
  quantity: Decimal,
  quoteFor: (id: string) => Promise<Quote | undefined>,
) {
  const { work, now } = ctx;
  const quote = await quoteFor(instrumentId);
  if (!quote) return;
  const accountId = c.legs.find((l) => l.instrumentId === instrumentId)
    ? (work.definition.entry.orders.find((o) => o.instrumentId === instrumentId)?.accountId ??
      work.accounts[0])
    : work.accounts[0];
  if (!accountId) return;
  const legId = `flatten-${instrumentId}`;
  const key = idempotencyKey({
    runtimeId: work.id,
    cycleId: c.id,
    phase: 'flatten',
    legId,
    attempt: 1,
  });
  const direction = quantity.gt(0) ? 'sell' : 'buy';
  const side = quantity.gt(0) ? 'sell' : 'buy_to_cover';
  const risk = checkPreTradeRisk({
    risk: {},
    closing: true,
    quantity: quantity.abs(),
    referencePrice: quote.last,
    activeOrders: 0,
    grossExposure: ZERO,
    equity: ZERO,
    dailyLossHit: false,
    drawdownHit: false,
    openPositions: 0,
    instrumentHeld: true,
  });
  const recorded = await recordOrderIntent(tx, work.userId, {
    runtimeId: work.id,
    strategyId: work.strategyId,
    versionId: work.versionId,
    cycleId: c.id,
    phase: 'flatten' as PhaseName,
    plannedOrderId: undefined,
    attempt: 1,
    legLabel: `Close ${quote.symbol}`,
    triggerEventId: undefined,
    scheduledActionId: undefined,
    eligibleAt: now.toISOString(),
    accountId,
    instrumentId,
    side,
    direction,
    quantity: quantity.abs().toString(),
    orderType: 'market',
    limitPrice: undefined,
    stopPrice: undefined,
    timeInForce: 'day',
    extendedHours: false,
    referencePrice: quote.last.toString(),
    risk,
    idempotencyKey: key,
    source: 'system',
  });
  if (!recorded.created || recorded.state !== 'ready') return;
  await submit(tx, ctx, recorded.intentId, {
    clientOrderId: key,
    accountId,
    instrumentId,
    symbol: quote.symbol,
    direction,
    short: false,
    quantity: quantity.abs().toString(),
    orderType: 'market',
    timeInForce: 'day',
    extendedHours: false,
  });
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface RuntimeLoop {
  stop(): Promise<void>;
}

/** Leases due runtimes and runs a pass over each, every `pollMs`. */
export function startRuntimeLoop(
  options: RuntimeWorkerOptions & { pollMs: number; batch?: number },
): RuntimeLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> | undefined;
  const tick = async () => {
    const claimed = await claimRuntimes(options.db, options.workerId, {
      leaseSeconds: options.leaseSeconds ?? 60,
      limit: options.batch ?? 10,
    });
    for (const { runtimeId, userId } of claimed) {
      if (stopped) return;
      try {
        await runRuntimePass(options, runtimeId, userId);
      } catch (error) {
        options.logger.error({ err: error, runtimeId }, 'runtime pass failed');
      }
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      current = tick()
        .catch((error: unknown) => options.logger.error({ err: error }, 'runtime loop failed'))
        .finally(schedule);
    }, options.pollMs);
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
