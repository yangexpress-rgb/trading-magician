import {
  loadData,
  MarketView,
  paperEvaluationInputs,
  type InstrumentRef,
  type LoadedData,
  planSeries,
  seriesExprs,
  watchOnlyInstruments,
} from '@tm/backtest';
import { PaperBroker } from '@tm/broker';
import {
  applyBrokerUpdates,
  claimRuntimes,
  DbPaperBrokerStore,
  finishScheduled,
  getReconciledAt,
  heartbeatInstrumentId,
  hasBlockingIncident,
  pauseIncident,
  filledSince,
  resumeRuntime,
  runtimePauseReason,
  idempotencyKey,
  insertCycle,
  intentsByClientOrderId,
  loadEventData,
  loadOptionSignals,
  loadMlPredictions,
  loadRuntimeWork,
  lockPaperBroker,
  markOrderFailed,
  markOrderSubmitted,
  notify,
  openIncident,
  openPriceIncident,
  closePriceIncident,
  hasOpenIncidentOfKind,
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
  feedScope,
  instrumentRefs,
  runtimeAccountId,
  type CredentialKey,
  recordSafetyClose,
  accountExposureBook,
} from '@tm/db';
import { RuntimeBarCache, RuntimeSideData, RuntimeUniverses } from './runtime-cache';
import {
  addDays,
  fundamentalInstruments,
  eventInstruments,
  optionInstruments,
  mlReads,
  activeFromFor,
  collarAtRelease,
  sampledInSessionAt,
  type CollarRelease,
  holdsForOpenCollar,
  regularSessionOpenAt,
  sendsExtendedHours,
  BrokerRejectedError,
  BrokerUnavailableError,
  checkPreTradeRisk,
  safetyCloseReason,
  stepStrategyTrail,
  strategyTrailDue,
  strategyTrailText,
  evaluateCondition,
  evaluateExpr,
  hasComparisons,
  listMembers,
  planSlots,
  rankUniverse,
  scheduledPeriod,
  scheduleOf,
  normalSchedule,
  exitScheduleOf,
  readsThisInstrument,
  selectionOf,
  isCalendarSchedule,
  selectionCount,
  selectLegs,
  slotDefinition,
  groupDefinition,
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
  sizesFromAtr,
  riskSizingCap,
  stopCloseExpr,
  stopInterval,
  holdingReads,
  tradingDaysHeld,
  newRuntimeTriggerState,
  slotKey,
  slotModeOf,
  withContext,
  type Slot,
  type Schedule,
  type StrategyDefinition,
  newCycleState,
  nyDate,
  regularSession,
  planCycle,
  planEntry,
  rearmEntryTrigger,
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
  type BuiltinUniverse,
  type RiskCheckInput,
} from '@tm/domain';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Logger } from 'pino';
import { demoProvider, type ProviderRegistry } from './providers';
import { accountResolver, createAccountRouter } from './account-router';
import type { BrokerRegistry } from './brokers';
import { createRoutedHistory } from './routed-history';
import { quotesForAccount } from './account-quotes';
import { QuoteHub } from './quote-hub';
import { quoteTrail, type RoutedQuotes } from './routed-quotes';
import { NO_COMPANY_FEED, type FundamentalsLoader } from './fundamentals';
import { equityLimits } from './equity-limits';
import {
  effectivePriceAgeSec,
  feedIncidentSummary,
  feedVerdict,
  type FeedVerdict,
  type WatchedPrice,
} from './feed-watch';
import { isThrottled, type AccountSyncGate } from './account-sync';
import {
  AUTO_RESUME,
  autoResumeStep,
  REJECT_RETRIES,
  rejectsResumeStep,
  type AutoPauseKind,
} from './auto-resume';

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
  /**
   * Bars, group members and other data kept between passes (ADR 0087). The
   * worker always has them; without them (some tests) every pass loads afresh.
   */
  caches?: RuntimeCaches;
  /**
   * Least time between two passes over one runtime (ADR 0087). Each pass asks
   * the broker for updates and the feed for prices, so passing every second
   * spent a single Alpaca key's 200 requests a minute on its own. Tests leave
   * it at 0 and drive passes themselves.
   */
  passEveryMs?: number;
  /**
   * One account sync shared by the strategies on an account (N282, ADR 0097).
   * The worker always has it; tests leave it out and every pass syncs.
   */
  accountSync?: AccountSyncGate;
  /** A built-in stock group's members, as back tests resolve them (ADR 0080, 0087). */
  resolveUniverse?: (
    userId: string,
    group: BuiltinUniverse,
  ) => Promise<{ ids: string[]; warnings: string[] }>;
}

/** Data besides bars that a pass reads, kept for a minute when caches are on. */
type SideData = Pick<LoadedData, 'fundamentals' | 'options' | 'events' | 'ml'>;

export interface RuntimeCaches {
  bars: RuntimeBarCache;
  universes: RuntimeUniverses;
  side: RuntimeSideData<SideData>;
  /** Live prices shared by every runtime, one feed request at a time (N326). */
  quotes: QuoteHub;
}

export function createRuntimeCaches(
  resolveUniverse?: RuntimeWorkerOptions['resolveUniverse'],
  logger?: Pick<Logger, 'info' | 'warn'>,
): RuntimeCaches {
  return {
    bars: new RuntimeBarCache(),
    universes: new RuntimeUniverses(resolveUniverse),
    side: new RuntimeSideData<SideData>(),
    quotes: new QuoteHub({ logger, trail: quoteTrail }),
  };
}

const ZERO = new Decimal(0);
/** How long before the close the paper runtime flattens at session end (N256, O156). */
export const SESSION_END_LEAD_MS = 5 * 60_000;

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
  /** How long Alpaca may keep answering "too many requests" before a pause (N282). */
  throttledPauseMs: 300_000,
} as const;

/** How long prices must stay current before a price incident closes itself (N326). */
export const FEED_CLEAR_MS = 30_000;

/** What went wrong with the broker during a pass. */
interface PassHealth {
  brokerDown: boolean;
  /** The broker answered "too many requests": it is there, the key is over its limit (N282). */
  throttled?: boolean;
  /** Whether the price feed gave a fresh price this pass (N276); quiet quotes then count as current. */
  feedLive?: boolean;
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

/**
 * The close a kept-as-saved stop may read (N225): the latest close of `expr`,
 * or undefined when there is no close, no bar end, no Entry fill yet, or the
 * bar ended before Entry first filled. A bar ending exactly at the fill counts.
 */
export function closeSinceFill(
  view: SeriesResolver,
  expr: ReturnType<typeof stopCloseExpr>,
  firstFill: number | undefined,
): Decimal | undefined {
  const close = evaluateExpr(expr, view);
  const at = view.barEnd?.(expr, 0);
  if (!close || at === undefined || firstFill === undefined || at < firstFill) return undefined;
  return close;
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

  // A member without a price feed of their own uses the admin's shared ones (N237, ADR 0084).
  const feeds = await feedScope(db, userId, 'prices');
  return withTenant(db, { userId }, async (tx) => {
    await lockPaperBroker(tx, userId);
    // Bars, like prices, come through the tenant's routes (ADR 0017).
    const history = createRoutedHistory({
      inTenant: feeds.shared ? feeds.inTenant : (fn) => fn(tx),
      userId: feeds.userId,
      now: at,
      providers,
      privateKey: options.privateKey,
    });
    // Prices come from the run's account's own feeds when it has any (ADR 0108),
    // otherwise through the tenant's routes, failing over between feeds (ADR 0016).
    const quotes = await quotesForAccount({
      tx,
      userId,
      accountId: await runtimeAccountId(tx, runtimeId),
      now,
      providers,
      privateKey: options.privateKey,
      logger,
      feeds,
      decide: true,
      hub: options.caches?.quotes,
    });
    const store = new DbPaperBrokerStore(tx, userId);
    const paper = new PaperBroker({ quotes, store, now: at });

    let work = await loadRuntimeWork(tx, runtimeId, workerId);
    if (!work) return 'lost';
    // A Selection group's members: a list as stored, or a built-in group looked up (ADR 0087).
    const group = await groupMembers(options, tx, work, now);
    const withMembers = (w: RuntimeWork): RuntimeWork => {
      if (group)
        for (const [id, ref] of group.refs) if (!w.instruments.has(id)) w.instruments.set(id, ref);
      return w;
    };
    work = withMembers(work);
    const members = group?.ids ?? listMembers(work.definition);
    // Every price this pass reads, asked for together (ADR 0087): one request
    // for all the holdings instead of one each, every pass.
    await quotes.prefetch(watchedInstruments(work, new Set(members)));
    // The account's feed stopped and it is set to pause: this run is paused now too.
    if (quotes.step?.kind === 'pause')
      work = withMembers((await loadRuntimeWork(tx, runtimeId, workerId)) ?? work);

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
    const sync = await syncUpdates(tx, broker, work, health, now, options.accountSync);
    // 3. Periodic reconciliation against the broker (§8.5).
    const healed = sync.complete ? await reconcile(tx, broker, work, now, sync.unknown, health) : 0;
    if (sync.changed || healed > 0)
      work = withMembers((await loadRuntimeWork(tx, runtimeId, workerId)) ?? work);

    // 4. Automatic pauses (§8.6): a broker that stops answering, prices that go stale.
    work = await watchBroker(tx, work, now, health);
    if (work.status === 'running')
      work = await watchFeed(tx, work, quotes, now, new Set(members), health);
    else if (work.status === 'paused') {
      // A mismatch or repeated-rejects pause can lift itself too (N301).
      if (!work.state.autoPause) await adoptPause(tx, work, now);
      // A pause for a passing outage lifts itself once the cause has cleared (N283).
      if (work.state.autoPause)
        work = await autoResume(tx, work, quotes, now, new Set(members), health);
    }
    if (work.status === 'running' && work.state.autoPause) work.state.autoPause = undefined;

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
        members,
        caches: options.caches,
        scope: feeds.userId,
      });
      if (work.status === 'running') await watchRejects(tx, work);
    } else {
      await saveRuntimeState(tx, work.id, work.state, now);
    }
    // The next pass waits `passEveryMs` (ADR 0087), so a runtime's requests to
    // its feed and broker stay within the key's limit.
    await releaseRuntime(tx, runtimeId, workerId, options.passEveryMs ?? 0);
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
  now: Date,
  gate?: AccountSyncGate,
) {
  let changed = false;
  let complete = true;
  const unknown = new Map<string, string[]>();
  for (const accountId of work.accounts) {
    const t = now.getTime();
    // Another strategy on the account synced it moments ago: its updates are
    // already applied, so read its outcome instead of asking again (N282).
    if (gate && !gate.due(accountId, t)) {
      const last = gate.outcome(accountId);
      if (last?.brokerDown) health.brokerDown = true;
      if (last?.throttled) health.throttled = true;
      if (last?.brokerDown || last?.throttled) complete = false;
      continue;
    }
    const before = { brokerDown: health.brokerDown, throttled: health.throttled ?? false };
    health.brokerDown = false;
    health.throttled = false;
    await syncAccount(accountId);
    gate?.record(accountId, t, { brokerDown: health.brokerDown, throttled: health.throttled });
    health.brokerDown ||= before.brokerDown;
    health.throttled ||= before.throttled;
  }
  return { changed, complete, unknown };

  async function syncAccount(accountId: string) {
    let cursor = await getSyncCursor(tx, accountId);
    let done = false;
    for (let page = 0; page < 20 && !done; page++) {
      let result: Awaited<ReturnType<BrokerAdapter['updates']>>;
      try {
        result = await broker.updates(accountId, cursor);
      } catch (e) {
        if (!(e instanceof BrokerUnavailableError)) throw e;
        markUnavailable(health, e);
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
}

/** Notes a broker request that failed: throttled is not silent (N282). */
function markUnavailable(health: PassHealth, e: unknown) {
  if (isThrottled(e)) health.throttled = true;
  else health.brokerDown = true;
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
      markUnavailable(health, e);
    }
  }
  return healed;
}

/**
 * Pauses the runtime once the broker has not answered for a while, or has
 * kept answering "too many requests" for longer (N282); clears when it answers.
 */
async function watchBroker(
  tx: Transaction,
  work: RuntimeWork,
  now: Date,
  health: PassHealth,
): Promise<RuntimeWork> {
  const t = now.getTime();
  if (!health.throttled) work.state.throttledSince = undefined;
  else work.state.throttledSince ??= t;
  if (!health.brokerDown && !health.throttled) {
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
  if (health.brokerDown) work.state.brokerDownSince ??= t;
  if (work.status !== 'running') return work;
  const silentFor = work.state.brokerDownSince === undefined ? 0 : t - work.state.brokerDownSince;
  const throttledFor = work.state.throttledSince === undefined ? 0 : t - work.state.throttledSince;
  let kind: AutoPauseKind;
  let summary: string;
  if (health.brokerDown && silentFor >= SAFETY.brokerDownPauseMs) {
    kind = 'broker_disconnected';
    summary = `The paper broker has not answered for ${Math.round(silentFor / 1000)} seconds.`;
  } else if (health.throttled && throttledFor >= SAFETY.throttledPauseMs) {
    kind = 'broker_throttled';
    summary = `Alpaca has refused requests as over its limit for ${Math.round(throttledFor / 60_000)} minutes.`;
  } else {
    return work;
  }
  // Data incidents and their pauses use the broker_disconnected kind (no new incident kind).
  await openIncident(tx, {
    userId: work.userId,
    kind: 'broker_disconnected',
    runtimeId: work.id,
    summary,
    pause: [work.id],
    link: `/orders?strategy=${work.strategyId}`,
  });
  work.state.autoPause = { kind, reason: summary.slice(0, 500), at: t };
  return { ...work, status: 'paused' };
}

/**
 * Checks the live prices the rules depend on (§8.6): stale or missing prices
 * open an incident at once (orders are already refused by the stale-data risk
 * check) and pause the strategy if one stays that way. A quiet stock whose
 * price has not changed is not stale while the feed is live (N276, ADR 0096).
 */
async function watchFeed(
  tx: Transaction,
  work: RuntimeWork,
  quotes: LiveQuoteProvider,
  now: Date,
  members: ReadonlySet<string> = new Set(),
  health?: PassHealth,
): Promise<RuntimeWork> {
  const t = now.getTime();
  const limit = work.definition.execution.staleDataSec;
  const verdict = await readFeed(tx, work, quotes, now, members);
  if (health) health.feedLive = verdict.feedLive;
  work.state.staleSinceBy = verdict.staleSince;
  const link = `/orders?strategy=${work.strategyId}`;
  // An incident opened before N326 has no start of its own: it began when prices went stale.
  if (work.state.feedIncidentAt === undefined && work.state.staleSince !== undefined)
    work.state.feedIncidentAt = work.state.staleSince;
  if (verdict.bad.length === 0 && verdict.silent.length === 0) {
    work.state.staleSince = undefined;
    if (work.state.feedIncidentAt === undefined) return work;
    // Prices must stay current for a while before the incident closes, so a
    // feed that flickers is one incident, not one per pass (N326).
    work.state.feedClearSince ??= t;
    if (t - work.state.feedClearSince < FEED_CLEAR_MS) return work;
    await closePriceIncident(tx, {
      userId: work.userId,
      runtimeId: work.id,
      durationSec: (work.state.feedClearSince - work.state.feedIncidentAt) / 1000,
      why: 'prices were current again for 30 seconds',
      link,
    });
    work.state.feedIncidentAt = undefined;
    work.state.feedClearSince = undefined;
    return work;
  }
  work.state.feedClearSince = undefined;
  work.state.feedIncidentAt ??= t;
  if (verdict.bad.length > 0) work.state.staleSince ??= t;
  else work.state.staleSince = undefined;
  await openPriceIncident(tx, {
    userId: work.userId,
    runtimeId: work.id,
    summary: feedIncidentSummary(verdict, limit),
    bad: verdict.bad.length > 0,
    symbols: [...verdict.problems.map((p) => p.symbol), ...verdict.silent.map((s) => s.symbol)],
    link,
  });
  if (verdict.lost.length === 0) return work;
  const longest = Math.max(...verdict.lost.map((l) => l.seconds));
  const throttled = verdict.problems.some((p) => p.reason === 'throttled');
  const lostSummary = `Live prices for ${verdict.lost.map((l) => l.symbol).join(', ')} have been unavailable for ${longest} seconds${throttled ? ' (Alpaca refused the requests as over the key’s limit)' : ''}.`;
  await openIncident(tx, {
    userId: work.userId,
    kind: 'feed_loss',
    runtimeId: work.id,
    summary: lostSummary,
    pause: [work.id],
    link,
    // One notice per outage, naming what it paused (N326).
    notify: 'first_of_kind',
  });
  work.state.autoPause = { kind: 'feed_loss', reason: lostSummary.slice(0, 500), at: t };
  return { ...work, status: 'paused' };
}

/** The watched prices' verdict this pass (N276), without opening incidents. */
async function readFeed(
  tx: Transaction,
  work: RuntimeWork,
  quotes: LiveQuoteProvider,
  now: Date,
  members: ReadonlySet<string>,
): Promise<FeedVerdict> {
  const limit = work.definition.execution.staleDataSec;
  const prices: WatchedPrice[] = [];
  const why = (quotes as Partial<Pick<RoutedQuotes, 'missReason'>>).missReason;
  for (const { instrumentId, symbol } of watchedInstruments(work, members)) {
    const quote = await quotes.latestQuote({ instrumentId, symbol });
    prices.push({ instrumentId, symbol, quote, miss: quote ? undefined : why?.(instrumentId) });
  }
  const anyFresh = prices.some((p) => p.quote?.marketOpen && quoteAgeSec(p.quote, now) <= limit);
  const anyQuiet = prices.some((p) => p.quote?.marketOpen && quoteAgeSec(p.quote, now) > limit);
  // Nothing watched moved: ask a liquid instrument whether the feed itself is live.
  const heartbeat =
    !anyFresh && anyQuiet ? await heartbeatQuote(tx, quotes, work.instruments) : undefined;
  const verdict = feedVerdict({
    prices,
    heartbeat,
    now,
    staleDataSec: limit,
    pauseAfterMs: SAFETY.feedLossPauseMs,
    staleSince: work.state.staleSinceBy ?? {},
  });
  return verdict;
}

/**
 * Lifts a pause for a passing outage once its cause has cleared (N283, ADR
 * 0097): the broker answers again, or the prices are current. Only while the
 * runtime is still paused for that reason and nothing that needs a person is
 * open on it.
 */
async function autoResume(
  tx: Transaction,
  work: RuntimeWork,
  quotes: LiveQuoteProvider,
  now: Date,
  members: ReadonlySet<string>,
  health: PassHealth,
): Promise<RuntimeWork> {
  const pause = work.state.autoPause;
  if (!pause) return work;
  const t = now.getTime();
  if ((await runtimePauseReason(tx, work.id)) !== pause.reason) {
    work.state.autoPause = undefined;
    return work;
  }
  // Anything that needs a person open on the runtime or its accounts holds it
  // until it is resolved: by a person, or by a clean reconciliation (N301).
  const blocked = await hasBlockingIncident(tx, work.id, work.accounts, {
    exceptOwnRejects: pause.kind === 'repeated_rejects',
  });
  let healthy: boolean;
  if (pause.kind === 'feed_loss') {
    const verdict = await readFeed(tx, work, quotes, now, members);
    work.state.staleSinceBy = verdict.staleSince;
    healthy = verdict.bad.length === 0;
  } else {
    healthy = !health.brokerDown && !health.throttled;
  }
  const rejects = pause.kind === 'repeated_rejects';
  const step = rejects
    ? rejectsResumeStep({ pause, retries: work.state.rejectRetries ?? 0, blocked, now: t })
    : autoResumeStep({
        pause,
        counts: work.state.autoResumes,
        today: nyDate(now),
        healthy: healthy && !blocked,
        now: t,
      });
  const link = `/orders?strategy=${work.strategyId}`;
  if (step.action === 'wait') {
    work.state.autoPause = step.pause;
    return work;
  }
  if (step.action === 'give_up') {
    work.state.autoPause = step.pause;
    await notify(tx, {
      userId: work.userId,
      kind: rejects ? 'risk_pause' : 'disconnect',
      title: `${work.strategyName} stays paused`,
      body: rejects
        ? `Its orders were refused again after ${REJECT_RETRIES} automatic retries at the open, with nothing filled in between. ${pause.reason} Resume it from Orders once the cause is fixed.`
        : `It already resumed on its own ${AUTO_RESUME.perDay} times today. Resume it from Orders when you are ready.`,
      link,
      resourceType: 'strategy_runtime',
      resourceId: work.id,
      dedupeKey: rejects
        ? `auto_resume_cap:${work.id}:${pause.at}`
        : `auto_resume_cap:${work.id}:${nyDate(now)}`,
    });
    return work;
  }
  if (!(await resumeRuntime(tx, work.userId, work.id))) return work;
  if (rejects) {
    await resolveIncidentsOf(
      tx,
      work.userId,
      'repeated_rejects',
      work.id,
      'Retried on its own at the market open',
    );
  } else if (pause.kind !== 'reconciliation_mismatch') {
    await resolveIncidentsOf(
      tx,
      work.userId,
      pause.kind === 'feed_loss' ? 'feed_loss' : 'broker_disconnected',
      work.id,
      'Resumed on its own after the outage cleared',
    );
  }
  if (pause.kind === 'feed_loss') {
    const since = work.state.feedIncidentAt ?? work.state.staleSince ?? pause.at;
    await closePriceIncident(tx, {
      userId: work.userId,
      runtimeId: work.id,
      durationSec: (t - since) / 1000,
      why: 'prices were current again and the strategy resumed',
      link,
    });
  }
  // A feed outage pauses every strategy on the feed: one notice when the last resumes (N326).
  const quietResume =
    pause.kind === 'feed_loss' && (await hasOpenIncidentOfKind(tx, work.userId, 'feed_loss'));
  await recordAudit(tx, {
    userId: work.userId,
    actorType: 'system',
    action: 'runtime.resumed',
    resourceType: 'strategy_runtime',
    resourceId: work.id,
    context: {
      auto: true,
      cause: pause.kind,
      attempt: step.attempt,
      pausedAt: new Date(pause.at).toISOString(),
    },
  });
  if (!quietResume)
    await notify(tx, {
      userId: work.userId,
      kind: rejects ? 'risk_pause' : 'disconnect',
      title: `${work.strategyName} resumed on its own`,
      body: rejects
        ? `${pause.reason} It is trying again at the market open (automatic retry ${step.attempt} of ${REJECT_RETRIES}; it stays paused if its orders are refused again before one fills).`
        : pause.kind === 'reconciliation_mismatch'
          ? `${pause.reason} Reconciliation has since come back clean, so it is running again (automatic resume ${step.attempt} of ${AUTO_RESUME.perDay} today).`
          : `${pause.reason} That has cleared, so it is running again (automatic resume ${step.attempt} of ${AUTO_RESUME.perDay} today).`,
      link,
      resourceType: 'strategy_runtime',
      resourceId: work.id,
      dedupeKey: `auto_resume:${work.id}:${t}`,
    });
  work.state.autoPause = undefined;
  work.state.pauseChecked = undefined;
  if (rejects) work.state.rejectRetries = step.attempt;
  else work.state.autoResumes = step.count;
  work.state.brokerDownSince = undefined;
  work.state.throttledSince = undefined;
  work.state.staleSince = undefined;
  work.state.feedIncidentAt = undefined;
  work.state.feedClearSince = undefined;
  return { ...work, status: 'running', activeSince: now };
}

/**
 * Takes on a pause a reconciliation mismatch or repeated rejects gave the
 * runtime, so it can lift itself (N301, ADR 0103). Looked up once per pause
 * reason; a pause no incident explains (a person's, the kill switch's) is left.
 */
async function adoptPause(tx: Transaction, work: RuntimeWork, now: Date): Promise<void> {
  const reason = await runtimePauseReason(tx, work.id);
  if (!reason || work.state.pauseChecked === reason) return;
  work.state.pauseChecked = reason;
  const incident = await pauseIncident(tx, work.id, work.accounts, reason);
  if (!incident) return;
  if (incident.kind === 'repeated_rejects') {
    // An order that filled since the last resume shows the strategy can trade:
    // the run of retries starts again.
    if (await filledSince(tx, work.id, work.activeSince)) work.state.rejectRetries = 0;
  }
  // Timed from when the worker first sees it, on the runtime's clock: moments
  // after the pause, or at once for a pause from before this existed.
  work.state.autoPause = { kind: incident.kind, reason, at: now.getTime() };
}

/** A liquid ETF the feed always prices, to tell a quiet stock from a silent feed. */
const HEARTBEAT_SYMBOL = 'SPY';

async function heartbeatQuote(
  tx: Transaction,
  quotes: LiveQuoteProvider,
  known: ReadonlyMap<string, InstrumentRef>,
): Promise<Quote | undefined> {
  for (const [instrumentId, ref] of known)
    if (ref.symbol === HEARTBEAT_SYMBOL)
      return quotes.latestQuote({ instrumentId, symbol: ref.symbol });
  const instrumentId = await heartbeatInstrumentId(tx);
  return instrumentId ? quotes.latestQuote({ instrumentId, symbol: HEARTBEAT_SYMBOL }) : undefined;
}

/**
 * The instruments whose live prices a pass watches. A group member's price
 * matters once the runtime holds it or has an order on it; before that, the
 * pre-trade check refuses an order on a stale price (ADR 0087). Watching all
 * 500 would ask for 500 prices every pass. An index has daily closes only and
 * is never traded, so it has no live price to watch (v1.2 item 5).
 */
function watchedInstruments(
  work: RuntimeWork,
  members: ReadonlySet<string>,
): { instrumentId: string; symbol: string }[] {
  const active = new Set<string>(work.working.map((o) => o.intent.instrumentId));
  for (const [id, q] of work.book.positions) if (!q.isZero()) active.add(id);
  const out: { instrumentId: string; symbol: string }[] = [];
  for (const [instrumentId, ref] of work.instruments) {
    if (isIndicatorOnlyClass(ref.assetClass)) continue;
    if (members.has(instrumentId) && !active.has(instrumentId)) continue;
    out.push({ instrumentId, symbol: ref.symbol });
  }
  return out;
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
      markUnavailable(health, e);
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
async function submitReady(
  tx: Transaction,
  ctx: Omit<PassContext, 'history' | 'members' | 'scope' | 'caches'>,
) {
  const open = regularSessionOpenAt(ctx.now.getTime());
  const risk = ctx.work.definition.risk;
  for (const o of ctx.work.working) {
    if (o.state !== 'ready' || o.brokerOrderId || o.cancelRequested) continue;
    const i = o.intent;
    if (i.source === 'strategy' && risk.priceCollarPct && holdsForOpenCollar(i, risk)) {
      // Held for the open (see placeLeg); released only within the collar.
      if (!open) continue;
      const release = await releaseHeldOrder(ctx, o, risk.priceCollarPct);
      if (release.kind === 'wait') continue;
      if (release.kind === 'block') {
        await requestCancel(tx, i.id, 'app', release.reason);
        await recordAudit(tx, {
          userId: ctx.work.userId,
          actorType: 'system',
          action: 'order.collar_blocked',
          resourceType: 'order_intent',
          resourceId: i.id,
          context: { runtimeId: ctx.work.id, ...collarAuditContext(release, risk.priceCollarPct) },
        });
        continue;
      }
      ctx.logger.info(
        {
          intentId: i.id,
          runtimeId: ctx.work.id,
          ...collarAuditContext(release, risk.priceCollarPct),
        },
        'held order released within the collar',
      );
    }
    await submit(tx, ctx, i.id, requestFor(o));
  }
}

/**
 * The collar check for an order held for the open (N325, ADR 0113), the only
 * place a paper collar anchor is sampled. The anchor is the release snapshot,
 * this pass's price for the instrument, and must be from the session the order
 * is sent in; it is compared with the price read again from the feed at the
 * send attempt. The order's decision price (`referencePrice`, from an earlier
 * session by construction) is never read here.
 */
export async function releaseHeldOrder(
  ctx: Pick<PassContext, 'quotes' | 'now'>,
  o: Pick<WorkingOrder, 'symbol'> & { intent: Pick<WorkingOrder['intent'], 'instrumentId'> },
  collarPct: string,
): Promise<CollarRelease> {
  const ref = { instrumentId: o.intent.instrumentId, symbol: o.symbol };
  const snapshot = await ctx.quotes.latestQuote(ref);
  const now = ctx.now.getTime();
  // Not yet a price from this session (e.g. no trade since the open): wait for one.
  if (!snapshot || !sampledInSessionAt(snapshot.at, now)) return { kind: 'wait' };
  const sendQuote = ctx.quotes.freshQuote
    ? await ctx.quotes.freshQuote(ref)
    : await ctx.quotes.latestQuote(ref);
  return collarAtRelease({ snapshot, sendQuote, now, collarPct });
}

/** Both prices the collar compared, when each was sampled and the anchor's source. */
function collarAuditContext(
  r: Exclude<CollarRelease, { kind: 'wait' }>,
  collarPct: string,
): Record<string, string> {
  return {
    anchorSource: r.anchor.source,
    anchorPrice: r.anchor.price.toString(),
    anchorAt: r.anchor.at,
    priceSource: r.price.source,
    price: r.price.price.toString(),
    priceAt: r.price.at,
    movePct: r.movePct.toDecimalPlaces(4).toString(),
    collarPct,
  };
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
  /** The group's members today (empty without a group). */
  members: string[];
  caches?: RuntimeCaches | undefined;
  /** Whose feeds answer, so runtimes on the same feeds share loaded bars. */
  scope: string;
}

/**
 * What a pass reads besides bars: company filings, options signals, earnings
 * and deals, model scores, each only when the rules read it.
 */
async function loadSideData(
  tx: Transaction,
  ctx: PassContext,
  members: readonly string[],
): Promise<SideData> {
  const { work, now } = ctx;
  const def = work.definition;
  const out: SideData = {};
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
      out.fundamentals = loaded.byId;
    } catch (error) {
      const e = error as { name?: string; message?: string };
      ctx.logger.warn(
        { runtimeId: work.id, err: { name: e.name, message: e.message } },
        'fundamentals unavailable',
      );
    }
  }
  // Options metrics read the latest end-of-day signal (options brief v2 §5.3): at
  // most one change a day, unknown when the latest is over 5 trading days old.
  const underlyings = optionInstruments(def, members);
  if (underlyings.length > 0)
    out.options = await loadOptionSignals(tx, underlyings, addDays(nyDate(now), -14));
  // Earnings, deals and rates: the latest record on or before each bar (ADR 0058).
  const eventReads = eventInstruments(def, members);
  if (eventReads.size > 0) out.events = await loadEventData(tx, eventReads);
  // Stored model scores (ML brief v1 §8): the latest prediction, unknown past 45 days.
  const mlWanted = mlReads(def, members);
  if (mlWanted.size > 0) out.ml = await loadMlPredictions(tx, mlWanted, addDays(nyDate(now), -60));
  return out;
}

/** A built-in group's members and their instruments, today's list (ADR 0087). */
async function groupMembers(
  options: RuntimeWorkerOptions,
  tx: Transaction,
  work: RuntimeWork,
  now: Date,
): Promise<{ ids: string[]; refs: Map<string, InstrumentRef> } | undefined> {
  const trade = work.definition.trade;
  if (trade.kind !== 'group' || trade.universe.type !== 'builtin') return undefined;
  const universes = options.caches?.universes ?? new RuntimeUniverses(options.resolveUniverse);
  return universes.members(work.userId, trade.universe.id, now, (ids) => instrumentRefs(tx, ids));
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
  const members = ctx.members;
  const plans = planSeries(
    def,
    paperEvaluationInputs(nyDate(now)),
    members,
    watchOnlyInstruments(work.instruments),
  );
  // Bars stay loaded between passes; only a newly finished bar is asked for (ADR 0087).
  // A member whose bars fail is left out of the pass, as in back tests.
  const data: LoadedData = ctx.caches
    ? await ctx.caches.bars.load({
        scope: ctx.scope,
        owner: work.id,
        history: ctx.history,
        plans,
        instruments: work.instruments,
        now,
        optional: new Set(members),
      })
    : await loadData(ctx.history, plans, work.instruments, undefined, new Set(members));
  let dataTime = 0;
  for (const e of seriesExprs(def, members)) {
    const bars = data.series.get(`${e.instrumentId}|${e.interval}|${e.adjustment}|${e.session}`);
    const last = bars?.findLast((b) => Date.parse(b.end) <= t);
    if (last) dataTime = Math.max(dataTime, Date.parse(last.end));
  }
  const newData = dataTime > 0 && dataTime > (state.lastDataTime ?? 0);
  const side = ctx.caches
    ? await ctx.caches.side.get(work.id, members.join(','), t, newData, () =>
        loadSideData(tx, ctx, members),
      )
    : await loadSideData(tx, ctx, members);
  Object.assign(data, side);
  const view = new MarketView(
    data.series,
    watchOnlyInstruments(work.instruments),
    data.fundamentals,
    data.options,
    data.events,
    data.ml,
  );
  view.advance(t);
  if (newData) state.lastDataTime = dataTime;
  // Check Entry gates Entry and re-selection; Check Exit gates Exit (ADR 0073).
  // Every intraday bar counts the newest bar's end; checks after the close count closes (N184).
  // The 1st or 2nd bar (N226, N227) is checked on its day once that bar is in.
  // Rules on intraday bars wait for that bar; rules on daily bars only have
  // yesterday's close, so the clock decides. Before the open is clock-driven:
  // one bar (at most an hour) before the scheduled day's open.
  const intraday = seriesExprs(def, members).some(
    (e) => e.interval !== '1d' && e.interval !== '1w',
  );
  // Strategy trailing stop (N291, ADR 0100): measured on the whole strategy,
  // only when every holding has a mark; once fired, every cycle closes.
  // It is judged on the strategy's own bars, as the back test does (N306,
  // ADR 0105): a daily strategy once its daily bar closes, an intraday one on
  // every pass. Going flat resets it at once.
  let trailClosing = state.strategyTrail?.firedAt !== undefined;
  let trailFiredText: string | undefined;
  if (limits.complete) {
    const holding = [...work.book.positions.values()].some((q) => !q.isZero());
    if (strategyTrailDue({ intraday, newBar: newData, holding })) {
      const trail = stepStrategyTrail({
        limitPct: def.risk.trailingStopPct,
        state: state.strategyTrail,
        equity,
        gross,
        holding,
        now: t,
      });
      state.strategyTrail = trail.state;
      trailClosing = trail.closing;
      if (trail.fired && trail.state && def.risk.trailingStopPct) {
        trailFiredText = strategyTrailText(def.risk.trailingStopPct, trail.state);
        await recordAudit(tx, {
          userId: work.userId,
          actorType: 'system',
          action: 'runtime.strategy_trailing_stop',
          resourceType: 'strategy_runtime',
          resourceId: work.id,
          context: { ...trail.state, limitPct: def.risk.trailingStopPct },
        });
      }
    }
  }
  /** Why this runtime's closing orders go, in words (N306); stored on each one. */
  const closeReasonFor = (notes: readonly string[]): string =>
    safetyCloseReason(
      notes.includes('session_end')
        ? { kind: 'session_end' }
        : notes.includes('strategy_trailing_stop')
          ? {
              kind: 'strategy_trailing_stop',
              detail:
                trailFiredText ??
                (state.strategyTrail && def.risk.trailingStopPct
                  ? strategyTrailText(def.risk.trailingStopPct, state.strategyTrail)
                  : undefined),
            }
          : { kind: 'leg_failed' },
    );
  const due = (schedule: Schedule, last: string | undefined): string | undefined => {
    const s = normalSchedule(schedule);
    if (s.which === 'beforeOpen') return dataTime > 0 ? scheduledPeriod(s, t, last, t) : undefined;
    if ((s.which === 'first' || s.which === 'second') && s.bar !== '1d') {
      if (dataTime <= 0 || (intraday && !newData)) return undefined;
      return scheduledPeriod(s, t, last, intraday ? dataTime : t);
    }
    return newData ? scheduledPeriod(s, t, last, dataTime) : undefined;
  };
  const schedule = scheduleOf(def);
  const period = due(schedule, state.lastSchedulePeriod);
  const entryDue = period !== undefined;
  if (entryDue) state.lastSchedulePeriod = period;
  // Check Exit (ADR 0073): without one, Exit is checked on every new bar, as before.
  const exitSchedule = exitScheduleOf(def);
  let exitDue = newData;
  if (exitSchedule) {
    const exitPeriod = due(exitSchedule, state.lastExitSchedulePeriod);
    exitDue = exitPeriod !== undefined;
    if (exitPeriod !== undefined) state.lastExitSchedulePeriod = exitPeriod;
  }
  /** The group What to trade names, as the engines run it (ADR 0073). */
  const selection = selectionOf(def);
  const evaluate = (phase: PhaseName, r: SeriesResolver = view, d = def): Truth =>
    evaluateCondition(d[phase].condition, r);
  /** Minutes held (N255): whole minutes from the cycle's earliest Entry fill to this pass. */
  const minutesHeld = (c: ActiveCycle): { minutesHeld?: number } => {
    const fills = c.legs
      .filter((l) => l.phase === 'entry' && l.firstFillAt !== undefined)
      .map((l) => l.firstFillAt as number);
    if (fills.length === 0) return {};
    const opened = Math.min(...fills);
    return t < opened ? {} : { minutesHeld: Math.floor((t - opened) / 60_000) };
  };
  // Flatten at session end (N256): on paper, the session's final passes are its
  // last five minutes, while closing orders can still trade before the close.
  const sessionToday = regularSession(nyDate(now));
  const sessionEnd =
    def.execution.flattenAtSessionEnd === true &&
    sessionToday !== undefined &&
    t >= Date.parse(sessionToday.close) - SESSION_END_LEAD_MS &&
    t < Date.parse(sessionToday.close);
  /** The view plus a cycle's positions, for Exit rules and Exit order prices. */
  const cycleView = (c: ActiveCycle): SeriesResolver => {
    const r = withPositions(view, (id) => {
      const e = c.entries.get(id);
      if (!e || e.quantity.isZero()) return undefined;
      const k = c.cycle.peaks?.[id];
      const atr = c.cycle.atrsAtEntry?.[id];
      const move = c.cycle.movesAtEntry?.[id];
      const decimals = (r: Record<string, string>) =>
        Object.fromEntries(Object.entries(r).map(([n, v]) => [n, new Decimal(v)]));
      return {
        quantity: c.positions.get(id) ?? ZERO,
        averagePrice: e.cost.div(e.quantity),
        ...(k ? { peak: new Decimal(k.peak), checkClose: new Decimal(k.close) } : {}),
        ...(k?.at === undefined ? {} : { checkCloseAt: k.at }),
        ...(c.cycle.daysHeld === undefined ? {} : { daysHeld: c.cycle.daysHeld }),
        ...minutesHeld(c),
        ...(atr ? { atrAtEntry: decimals(atr) } : {}),
        ...(move ? { moveAtEntry: decimals(move) } : {}),
      };
    });
    // A slot's rules read "this instrument" as the slot's own (v1.2).
    return c.cycle.slot ? withContext(r, c.cycle.slot.instrumentId) : r;
  };
  const symbolOf = (id: string) => work.instruments.get(id)?.symbol ?? '?';
  const count = mode === 'selection' && selection ? selectionCount(selection, members.length) : 1;
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
  // While the strategy trailing stop closes everything, no new Entry either (N290).
  const entryHalted = halted || dailyLossHit || drawdownHit || !limits.complete || trailClosing;
  const cycles: ActiveCycle[] = [...work.cycles];
  let entryTruth: { truth: Truth } | undefined;
  let entryEventId: string | undefined;
  const newCycleIds: string[] = [];
  const rebalanceExits = new Set<string>();
  /** Cycles a timed leg opened that got their Entry trigger this pass. */
  const triggeredLater = new Set<string>();

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
    entryTruth = entryDue ? { truth: evaluate('entry') } : undefined;
    const severalGroups = (def.groups?.length ?? 0) > 0;
    const entry = planEntry({
      definition: def,
      state: state.trigger,
      active: work.cycles.map((c) => ({ id: c.id, cycle: c.cycle })),
      now: t,
      entryTruth,
      halted: entryHalted,
      severalGroups,
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
    } else if (entry.decision.kind === 'trigger_cycle') {
      // A cycle a timed leg opened on its own now has its Entry trigger too, as
      // in the back test (ADR 0049): legs waiting for "Entry triggered" can go.
      const target = cycles.find((c) => c.id === (entry.decision as { cycleId: string }).cycleId);
      if (target) {
        target.cycle = { ...target.cycle, entryTriggeredAt: t };
        target.entryTriggerEventId = entryEventId ?? null;
        triggeredLater.add(target.id);
      }
    }
    // Further entry groups (v1.2 item 8), in order: one enters only while no
    // cycle of any group is open, so a position is never flipped.
    for (const g of def.groups ?? []) {
      const gdef = groupDefinition(def, g.id);
      const truth = entryDue ? { truth: evaluate('entry', view, gdef) } : undefined;
      const planned = planEntry({
        definition: gdef,
        state: state.groupTriggers?.[g.id] ?? newRuntimeTriggerState(),
        active: cycles
          .filter((c) => c.cycle.status !== 'closed' && c.cycle.status !== 'aborted')
          .map((c) => ({ id: c.id, cycle: c.cycle })),
        now: t,
        entryTruth: truth,
        halted: entryHalted,
        severalGroups: true,
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
    let inGroup: Slot[] | undefined;
    if (mode === 'selection' && selection) {
      const template = def.entry.orders[0];
      const ranking = rankUniverse(selection, members, view, symbolOf);
      if (readsThisInstrument(def.entry.condition) && template) {
        // Enter when reads "this stock": checked for each selected member (ADR 0073).
        inGroup = ranking.selected.map((instrumentId) => ({ legId: template.id, instrumentId }));
        candidates = inGroup.filter(
          (c) => evaluateCondition(def.entry.condition, withContext(view, c.instrumentId)) === true,
        );
        entryTruth = { truth: candidates.length > 0 };
      } else {
        const gate: Truth = hasComparisons(def.entry.condition) ? evaluate('entry') : true;
        if (gate === true && template)
          candidates = ranking.selected.map((instrumentId) => ({
            legId: template.id,
            instrumentId,
          }));
        entryTruth = { truth: gate };
      }
    } else {
      const legs = selectLegs(def, view, symbolOf);
      candidates = legs.selected;
      entryTruth = { truth: candidates.length > 0 };
    }
    entryEventId = randomUUID();
    const plan = planSlots({
      mode,
      scheduled: isCalendarSchedule(schedule),
      candidates,
      held: work.cycles
        .filter((c) => c.cycle.slot)
        .map((c) => ({
          key: slotKey(c.cycle.slot as Slot),
          id: c.id,
          open: c.cycle.status === 'open',
        })),
      halted: entryHalted,
      keepHoldings: selection?.keepHoldings === true,
      ...(inGroup ? { inGroup } : {}),
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
      cycleId: newCycleIds[0] ?? [...triggeredLater][0],
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

  // Entry orders not yet filled hold exposure and buying power too (N278, ADR
  // 0096): a pass that places twenty entries, or entries that wait for the
  // open, must not each be checked against positions alone.
  let pendingGross = pendingEntryGross(work.working);

  // The account's own exposure limit (ADR 0107): what every run on the account
  // holds and has working, read once when an Entry is about to be checked.
  let accountGross: Decimal | undefined;
  // A live account in pilot mode is held to its pilot caps too (ADR 0109).
  const accountExposure = async () => {
    if (!work.accountMaxExposure && !work.accountPilot) return undefined;
    if (accountGross === undefined) {
      const book = await accountExposureBook(tx, work.accountId);
      accountGross = book.pendingEntry;
      for (const [id, p] of book.positions) {
        const px = (await markOf(id)) ?? p.lastPrice;
        accountGross = accountGross.plus(p.quantity.abs().times(px));
      }
    }
    return {
      maxExposure: work.accountMaxExposure ?? undefined,
      grossExposure: accountGross,
      pilot: work.accountPilot ?? undefined,
    };
  };

  // 4. Plan and act on each active cycle.
  const working = () => work.working.length;
  let placedThisPass = 0;
  // Exit when may read values kept for each holding (N217, N221).
  const holding = holdingReads(def);
  /** Safety closes placed this pass, by their reason, with the symbols closed (N306). */
  const safetyCloses = new Map<string, string[]>();
  for (const c of cycles) {
    const cycleDef = cycleDefinition(c);
    // Kept before Exit when is checked, with the trailing stop's arithmetic (ADR 0074).
    // ATRs and expected moves Exit when reads, fixed as the rules fix theirs (N221).
    if (holding.atrPeriods.length > 0 || holding.moveHorizons.length > 0) {
      const atrs = { ...(c.cycle.atrsAtEntry ?? {}) };
      const moves = { ...(c.cycle.movesAtEntry ?? {}) };
      for (const id of new Set(cycleDef.entry.orders.map((o) => o.instrumentId))) {
        const a = { ...(atrs[id] ?? {}) };
        for (const period of holding.atrPeriods)
          if (!a[period]) {
            const atr = evaluateExpr(atrExpr(id, period), view);
            if (atr) a[period] = atr.toString();
          }
        atrs[id] = a;
        const m = { ...(moves[id] ?? {}) };
        for (const h of holding.moveHorizons)
          if (!m[h]) {
            const move = evaluateExpr(expectedMoveExpr(id, h), view);
            if (move && move.gt(0)) m[h] = move.toString();
          }
        moves[id] = m;
      }
      c.cycle = { ...c.cycle, atrsAtEntry: atrs, movesAtEntry: moves };
    }
    if (holding.any && exitDue && c.cycle.status === 'open') {
      const opened = c.legs
        .filter((l) => l.phase === 'entry' && l.firstFillAt !== undefined)
        .map((l) => l.firstFillAt as number);
      if (opened.length > 0)
        c.cycle = { ...c.cycle, daysHeld: tradingDaysHeld(Math.min(...opened), t) };
      const peaks = { ...(c.cycle.peaks ?? {}) };
      const firstFill = opened.length > 0 ? Math.min(...opened) : undefined;
      for (const [id, e] of c.entries) {
        const held = c.positions.get(id) ?? ZERO;
        if (e.quantity.isZero() || held.isZero()) continue;
        const expr = stopCloseExpr(id, undefined, stopInterval(def));
        const close = evaluateExpr(expr, view);
        const at = view.barEnd(expr, 0);
        if (!close || at === undefined) continue;
        // A close from before Entry filled says nothing about this holding (N225).
        if (firstFill !== undefined && at < firstFill) continue;
        const start = peaks[id] ? new Decimal(peaks[id].peak) : e.cost.div(e.quantity);
        peaks[id] = {
          peak: trailingPeak(start, close, held.gt(0)).toString(),
          close: close.toString(),
          at,
        };
      }
      c.cycle = { ...c.cycle, peaks };
    }
    // The kept-as-saved stops below read only a close whose bar ended at or after
    // Entry first filled (N225), like the converted path above and the back test's
    // closeSinceEntry: no close, no bar end or no fill yet means no check this time.
    const entryFills = c.legs
      .filter((l) => l.phase === 'entry' && l.firstFillAt !== undefined)
      .map((l) => l.firstFillAt as number);
    const cycleFirstFill = entryFills.length > 0 ? Math.min(...entryFills) : undefined;
    const stopCloseSinceEntry = (instrument: string): Decimal | undefined =>
      closeSinceFill(view, stopCloseExpr(instrument, undefined, stopInterval(def)), cycleFirstFill);
    const exitTruth =
      exitDue && c.cycle.status === 'open'
        ? { truth: evaluate('exit', cycleView(c), cycleDef) }
        : undefined;
    // ATR stop (v1.2 item 9): the ATR is fixed when Entry is decided; a daily
    // close beyond entry ∓ multiple × that ATR exits, by OR with the condition.
    // The stop's distance is the Entry's risk distance unless it has its own (ADR 0049).
    const atrRule = atrStopOf(cycleDef) ? atrStopDistance(cycleDef) : undefined;
    const atrInstrument = atrStopInstrument(cycleDef);
    if (atrRule && atrInstrument && !c.cycle.atrAtEntry) {
      const atr = evaluateExpr(atrExpr(atrInstrument, atrRule.atrPeriod), view);
      if (atr) c.cycle = { ...c.cycle, atrAtEntry: atr.toString() };
    }
    let atrStopFired = false;
    if (exitDue && atrRule && atrInstrument && c.cycle.atrAtEntry && c.cycle.status === 'open') {
      const entry = c.entries.get(atrInstrument);
      const held = c.positions.get(atrInstrument) ?? ZERO;
      const close = stopCloseSinceEntry(atrInstrument);
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
    // Expected-move exit (ADR 0053): the options expected move is fixed when Entry
    // is decided; a daily close beyond entry × (1 ± multiple × move) exits, by OR.
    const moveRule = expectedMoveRuleOf(cycleDef);
    if (moveRule && atrInstrument && !c.cycle.moveAtEntry) {
      const move = evaluateExpr(expectedMoveExpr(atrInstrument, moveRule.horizon), view);
      if (move && move.gt(0)) c.cycle = { ...c.cycle, moveAtEntry: move.toString() };
    }
    let moveFired = false;
    if (exitDue && moveRule && atrInstrument && c.cycle.moveAtEntry && c.cycle.status === 'open') {
      const entry = c.entries.get(atrInstrument);
      const held = c.positions.get(atrInstrument) ?? ZERO;
      const close = stopCloseSinceEntry(atrInstrument);
      if (entry && !entry.quantity.isZero() && !held.isZero() && close) {
        const band = expectedMoveBand(
          entry.cost.div(entry.quantity),
          new Decimal(c.cycle.moveAtEntry),
          moveRule.multiple,
        );
        moveFired = expectedMoveHit(close, band, moveRule.side, held.gt(0));
      }
    }
    // Trailing stop (ADR 0059): the best daily close since Entry filled is kept
    // with the cycle; a close more than the percent off it exits, by OR.
    const trailRule = trailingStopRuleOf(cycleDef);
    let trailFired = false;
    if (exitDue && trailRule && atrInstrument && c.cycle.status === 'open') {
      const entry = c.entries.get(atrInstrument);
      const held = c.positions.get(atrInstrument) ?? ZERO;
      const close = stopCloseSinceEntry(atrInstrument);
      if (entry && !entry.quantity.isZero() && !held.isZero() && close) {
        const long = held.gt(0);
        const start = c.cycle.trailPeak
          ? new Decimal(c.cycle.trailPeak)
          : entry.cost.div(entry.quantity);
        trailFired = trailingStopHit(
          close,
          trailingStopLevel(start, trailRule.percent, long),
          long,
        );
        c.cycle = { ...c.cycle, trailPeak: trailingPeak(start, close, long).toString() };
      }
    }
    const plan = planCycle({
      definition: cycleDef,
      cycle: c.cycle,
      legs: c.legs,
      positions: c.positions,
      now: t,
      exitTruth,
      exitDue,
      sessionEnd,
      strategyStop: trailClosing,
      forceExit: rebalanceExits.has(c.id)
        ? 'rebalance'
        : atrStopFired
          ? 'atr_stop'
          : moveFired
            ? 'expected_move'
            : trailFired
              ? 'trailing_stop'
              : undefined,
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
          : cancel.reason === 'session_end'
            ? 'Session end: the position was flattened'
            : cancel.reason === 'strategy_trailing_stop'
              ? 'Trailing stop: the strategy closed its positions'
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
        gross: leg.phase === 'entry' ? gross.minus(closingGross).plus(pendingGross) : gross,
        dailyLossHit,
        drawdownHit,
        activeOrders: working() + placedThisPass,
        account: leg.phase === 'entry' ? accountExposure : undefined,
        onOpeningRecorded: (notional) => {
          pendingGross = pendingGross.plus(notional);
          if (accountGross !== undefined) accountGross = accountGross.plus(notional);
        },
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
      const reason = closeReasonFor(plan.notes);
      const symbols: string[] = [];
      for (const [instrumentId, q] of c.positions) {
        if (q.isZero()) continue;
        const symbol = await placeFlatten(tx, ctx, c, instrumentId, q, quoteFor, reason);
        if (symbol) symbols.push(symbol);
      }
      if (symbols.length > 0) {
        const prior = safetyCloses.get(reason) ?? [];
        safetyCloses.set(reason, [...prior, ...symbols]);
      }
    }

    let realizedPnl: string | undefined;
    if (plan.cycle.status === 'closed') realizedPnl = c.cash.toDecimalPlaces(2).toString();
    await saveCycle(tx, c.id, plan.cycle, {
      ...(triggeredLater.has(c.id) && c.entryTriggerEventId
        ? { entryTriggerEventId: c.entryTriggerEventId }
        : {}),
      ...(exitEventId && plan.notes.includes('exit_triggered')
        ? { exitTriggerEventId: exitEventId }
        : {}),
      ...(realizedPnl !== undefined ? { realizedPnl } : {}),
    });
    // A closed or aborted cycle re-arms its Entry trigger (ADR 0049), as in the
    // back test: "once per cycle" then fires again for the next cycle.
    if (!c.cycle.slot && (plan.notes.includes('closed') || plan.notes.includes('aborted'))) {
      if (c.cycle.group) {
        const g = state.groupTriggers?.[c.cycle.group];
        if (g) rearmEntryTrigger(g.entryTrigger);
      } else rearmEntryTrigger(state.trigger.entryTrigger);
    }
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

  // Every safety close says why, in the incident log and a notification (N306).
  for (const [reason, symbols] of safetyCloses) {
    await recordSafetyClose(tx, {
      userId: work.userId,
      runtimeId: work.id,
      strategyId: work.strategyId,
      strategyName: work.strategyName,
      reason,
      symbols,
      at: now,
    });
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
  /** The account's exposure limit and what the account holds, when it has one (ADR 0107). */
  account?: (() => Promise<RiskCheckInput['account']>) | undefined;
  /** Called with the notional of an order that opens or adds risk once it is recorded ready. */
  onOpeningRecorded?: ((notional: Decimal) => void) | undefined;
  triggerEventId: string | undefined;
}

/** Unfilled notional of a runtime's working Entry orders, at their reference prices. */
export function pendingEntryGross(working: readonly WorkingOrder[]): Decimal {
  let total = ZERO;
  for (const o of working) {
    if (o.intent.phase !== 'entry') continue;
    const left = new Decimal(o.intent.quantity).minus(o.filledQuantity);
    if (left.lte(0)) continue;
    total = total.plus(left.times(o.intent.referencePrice));
  }
  return total;
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
  // The Entry's one risk distance (ADR 0049).
  const riskDistance = sizesFromAtr(order) ? def.entry.risk : undefined;
  const atrPeriod = riskDistance?.atrPeriod;
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
          distance: riskDistance,
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
    account: sized.closing ? undefined : await input.account?.(),
    // Outside the session the last quote is old by design; orders then wait for the open.
    priceAgeSec: quote.marketOpen
      ? effectivePriceAgeSec(quote, now, ctx.health.feedLive ?? false)
      : undefined,
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
    pricedByFeedId: quote.feedId,
    risk,
    idempotencyKey: key,
    source: 'strategy',
  });
  if (!recorded.created || recorded.state !== 'ready') return false;
  if (!sized.closing) input.onOpeningRecorded?.(sized.quantity.times(quote.last));
  // Decided while the market is closed: wait for the open. The collar is then
  // anchored on a price from the send session, never this one (N325, releaseHeldOrder).
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

/**
 * Why an order may not go to the broker because its account is not its run's (A6, N310),
 * or null when it may. The run's account decides; nothing else does.
 */
export function crossAccountRefusal(runAccountId: string, orderAccountId: string): string | null {
  return runAccountId === orderAccountId
    ? null
    : "Refused before sending: this order names an account other than its run's account.";
}

async function submit(
  tx: Transaction,
  ctx: Pick<PassContext, 'broker' | 'work' | 'logger' | 'health'>,
  intentId: string,
  request: Parameters<BrokerAdapter['submitOrder']>[0],
): Promise<boolean> {
  // A6 (N310): an order only ever goes to its own run's account, checked here, before
  // the broker adapter, as well as by the database when the order was recorded.
  const crossAccount = crossAccountRefusal(ctx.work.accountId, request.accountId);
  if (crossAccount) {
    await markOrderFailed(tx, intentId, crossAccount);
    await recordAudit(tx, {
      userId: ctx.work.userId,
      actorType: 'system',
      action: 'order.account_refused',
      resourceType: 'order_intent',
      resourceId: intentId,
      context: { runtimeId: ctx.work.id, runAccountId: ctx.work.accountId },
    });
    ctx.logger.error({ intentId, runtimeId: ctx.work.id }, 'order for another account refused');
    return false;
  }
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
      markUnavailable(ctx.health, e);
      return false;
    }
    throw e;
  }
}

/**
 * A safety close (N306): a closing order for what a cycle still holds, after a
 * failed multi-leg plan (§6.7), at session end (N256) or when the strategy
 * trailing stop fires (N291). Each carries its reason in words.
 */
async function placeFlatten(
  tx: Transaction,
  ctx: PassContext,
  c: ActiveCycle,
  instrumentId: string,
  quantity: Decimal,
  quoteFor: (id: string) => Promise<Quote | undefined>,
  closeReason: string,
): Promise<string | undefined> {
  const { work, now } = ctx;
  const quote = await quoteFor(instrumentId);
  if (!quote) return undefined;
  const accountId = c.legs.find((l) => l.instrumentId === instrumentId)
    ? (work.definition.entry.orders.find((o) => o.instrumentId === instrumentId)?.accountId ??
      work.accounts[0])
    : work.accounts[0];
  if (!accountId) return undefined;
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
    pricedByFeedId: quote.feedId,
    risk,
    idempotencyKey: key,
    source: 'system',
    closeReason,
  });
  if (!recorded.created || recorded.state !== 'ready') return undefined;
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
  return quote.symbol;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface RuntimeLoop {
  stop(): Promise<void>;
}

/** A pass this long is logged. */
const SLOW_PASS_MS = 5_000;

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
      const started = Date.now();
      try {
        await runRuntimePass(options, runtimeId, userId);
      } catch (error) {
        options.logger.error({ err: error, runtimeId }, 'runtime pass failed');
      }
      // Passes run one after another, so a slow one holds every other runtime
      // back: logged so a stall shows up next to the prices it aged.
      const ms = Date.now() - started;
      if (ms >= SLOW_PASS_MS)
        options.logger.warn(
          { event: 'runtime.slow_pass', runtimeId, ms, claimed: claimed.length },
          'slow runtime pass',
        );
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
