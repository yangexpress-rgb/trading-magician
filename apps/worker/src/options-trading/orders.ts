import {
  applyBrokerUpdates,
  ensureOptionInstrument,
  idempotencyKey,
  markOrderSubmitted,
  saveCycle,
  loadContractList,
  recordOrderIntent,
  recordReprice,
  requestCancel,
  saveContractList,
  type ActiveCycle,
  type CachedContractList,
  type RuntimeWork,
  type Transaction,
} from '@tm/db';
import {
  addDays,
  BrokerRejectedError,
  BrokerUnavailableError,
  checkPreTradeRisk,
  contractInWords,
  effectivePrice,
  expiryStage,
  midLimit,
  safetyCloseReason,
  nyDate,
  optionQuoteProblem,
  optionsSettings,
  OPTIONS_DEFAULTS,
  positionIntentFor,
  regularSessionOpenAt,
  repriceClientOrderId,
  repriceLimit,
  resolveContract,
  sizeOrder,
  type BrokerAdapter,
  type BrokerOrderRequest,
  type BrokerPosition,
  type CyclePlan,
  type OptionOrderDetail,
  type OptionQuote,
  type PhaseName,
  type PlannedLeg,
  type PlannedOrder,
  type Quote,
  type RiskCheckInput,
  type RiskCheckResult,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import type { Logger } from 'pino';
import type { OptionQuoteSource } from './quotes';

/**
 * Options orders on paper (options brief v0.2 §§6–8, ADR 0123). Phase O1:
 * single-leg long options. An Entry leg resolves its contract from the list
 * cached in Core, fetches one quote, and goes as a limit at the mid once the
 * quote passes the gate; an Exit leg closes the contract its Entry holds. A
 * leg decided while the market is closed waits, and is resolved and priced
 * again at release. Nothing here runs for a stock or ETF leg.
 */

const ZERO = new Decimal(0);

export interface OptionPassContext {
  tx: Transaction;
  work: RuntimeWork;
  broker: BrokerAdapter;
  quotes: OptionQuoteSource;
  now: Date;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** The runtime's own submit: the account check, the broker call and the audit. */
  submit: (intentId: string, request: BrokerOrderRequest) => Promise<boolean>;
}

export interface OptionLegInput {
  cycle: ActiveCycle;
  plan: CyclePlan;
  leg: PlannedLeg;
  order: PlannedOrder;
  definition: StrategyDefinition;
  underlying: Quote | undefined;
  equity: Decimal;
  gross: Decimal;
  dailyLossHit: boolean;
  drawdownHit: boolean;
  activeOrders: number;
  account?: (() => Promise<RiskCheckInput['account']>) | undefined;
  onOpeningRecorded?: ((notional: Decimal) => void) | undefined;
  triggerEventId: string | undefined;
}

const skip = (plan: CyclePlan, leg: PlannedLeg): undefined => {
  if (!plan.cycle.skipped.includes(leg.key)) plan.cycle.skipped.push(leg.key);
  return undefined;
};

/** The options state kept on the runtime (sent and re-priced times, closed-market picks). */
export function optionsState(work: RuntimeWork) {
  work.state.options ??= {};
  return work.state.options;
}

// ---------------------------------------------------------------------------
// §6.3 The contract list
// ---------------------------------------------------------------------------

/** The expiry window and strike band an Entry leg needs read (§6.3). */
export function listWindow(
  spec: NonNullable<PlannedOrder['option']>,
  price: Decimal,
  today: string,
) {
  const target = spec.expiryRule.targetDte;
  const days = Math.min(730, Math.max(target * 2, target + 30));
  const pct = new Decimal(spec.strikeRule.type === 'atm' ? 0 : Math.abs(spec.strikeRule.pct)).plus(
    25,
  );
  return {
    expiryTo: addDays(today, days),
    strikeFrom: Decimal.max(price.times(new Decimal(100).minus(pct)).div(100), 0)
      .toDecimalPlaces(2)
      .toString(),
    strikeTo: price.times(new Decimal(100).plus(pct)).div(100).toDecimalPlaces(2).toString(),
  };
}

const covers = (l: CachedContractList, w: ReturnType<typeof listWindow>) =>
  l.expiryTo >= w.expiryTo &&
  new Decimal(l.strikeFrom).lte(w.strikeFrom) &&
  new Decimal(l.strikeTo).gte(w.strikeTo);

/**
 * Today's list for an underlying, read from the broker once a day and when a
 * run needs a wider window than the cached one; otherwise from Core. Undefined
 * when no list of today could be had.
 */
export async function contractListFor(
  ctx: Pick<OptionPassContext, 'tx' | 'broker' | 'now' | 'logger' | 'work'>,
  underlying: { id: string; symbol: string },
  window: ReturnType<typeof listWindow>,
): Promise<CachedContractList | undefined> {
  const today = nyDate(ctx.now);
  const cached = await loadContractList(ctx.tx, underlying.id);
  if (cached && cached.fetchedOn === today && covers(cached, window)) return cached;
  const wide =
    cached && cached.fetchedOn === today
      ? {
          expiryTo: cached.expiryTo > window.expiryTo ? cached.expiryTo : window.expiryTo,
          strikeFrom: Decimal.min(cached.strikeFrom, window.strikeFrom).toString(),
          strikeTo: Decimal.max(cached.strikeTo, window.strikeTo).toString(),
        }
      : window;
  if (!ctx.broker.optionContracts) return undefined;
  try {
    const contracts = await ctx.broker.optionContracts(ctx.work.accountId, {
      underlying: underlying.symbol,
      expirationGte: addDays(today, 1),
      expirationLte: wide.expiryTo,
      strikeGte: wide.strikeFrom,
      strikeLte: wide.strikeTo,
    });
    return await saveContractList(ctx.tx, {
      underlyingId: underlying.id,
      fetchedOn: today,
      fetchedAt: ctx.now,
      ...wide,
      contracts,
    });
  } catch (e) {
    if (!(e instanceof BrokerRejectedError) && !(e instanceof BrokerUnavailableError)) {
      if (!(e instanceof Error) || e.name !== 'AlpacaOptionsBudgetError') throw e;
    }
    ctx.logger.warn({ underlying: underlying.symbol, err: e }, 'options contract list not read');
    // A list from today, even if narrower, is still today's; an older one is not used (§6.1.5).
    return cached && cached.fetchedOn === today ? cached : undefined;
  }
}

// ---------------------------------------------------------------------------
// Placing an options leg
// ---------------------------------------------------------------------------

/** The contract a cycle holds for an Exit leg: same underlying and right as its Entry leg. */
export function heldContract(
  work: RuntimeWork,
  c: ActiveCycle,
  order: PlannedOrder,
): { id: string; quantity: Decimal } | undefined {
  for (const [id, q] of c.positions) {
    if (q.isZero()) continue;
    const o = work.instruments.get(id)?.option;
    if (o && o.underlyingId === order.instrumentId && o.right === order.option?.right)
      return { id, quantity: q };
  }
  return undefined;
}

const refusal = (
  code: RiskCheckResult['code'] & string,
  value?: string,
  limit?: string,
): RiskCheckResult => ({
  ok: false,
  code,
  checks: [
    {
      code,
      passed: false,
      ...(value !== undefined ? { value } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
  ],
});

export async function placeOptionLeg(
  ctx: OptionPassContext,
  input: OptionLegInput,
): Promise<boolean | undefined> {
  const { work, now, tx } = ctx;
  const { cycle: c, plan, leg, order, definition: def } = input;
  const spec = order.option;
  if (!spec) return skip(plan, leg);
  const entry = leg.phase === 'entry';
  const state = optionsState(work);
  const underlyingRef = work.instruments.get(order.instrumentId);
  if (!underlyingRef) return skip(plan, leg);
  const key = idempotencyKey({
    runtimeId: work.id,
    cycleId: c.id,
    phase: leg.phase,
    legId: leg.legId,
    attempt: leg.attempt,
  });

  // §6.2: nothing goes while the market is closed. An Entry's pick is noted
  // and made again at release, from the fresh list and quote.
  if (!regularSessionOpenAt(now.getTime())) {
    if (def.execution.marketHoursPolicy === 'cancel') return skip(plan, leg);
    if (entry && input.underlying && !state.picks?.[leg.key]) {
      const pick = await resolveFor(ctx, input, underlyingRef.symbol);
      if (pick.ok) {
        state.picks = {
          ...state.picks,
          [leg.key]: {
            contract: pick.contract.symbol,
            words: pick.words,
            at: now.toISOString(),
            listVersion: pick.listVersion,
          },
        };
      }
    }
    return false;
  }

  let contractId: string;
  let symbol: string;
  let detail: OptionOrderDetail;
  let held = ZERO;
  if (entry) {
    if (!input.underlying) return skip(plan, leg);
    const pick = await resolveFor(ctx, input, underlyingRef.symbol);
    if (!pick.ok) {
      return refuse(
        ctx,
        input,
        key,
        order.instrumentId,
        input.underlying.last,
        refusal('option_contract', pick.message),
      );
    }
    contractId = await ensureOptionInstrument(tx, {
      underlyingId: order.instrumentId,
      symbol: pick.contract.symbol,
      expiry: pick.contract.expiry,
      strike: pick.contract.strike,
      right: pick.contract.right,
      multiplier: pick.contract.multiplier,
      provider: 'alpaca',
      providerId: pick.contract.symbol,
    });
    symbol = pick.contract.symbol;
    work.instruments.set(contractId, {
      symbol,
      assetClass: 'option',
      lotSize: '1',
      multiplier: pick.contract.multiplier,
      option: {
        underlyingId: order.instrumentId,
        right: pick.contract.right,
        strike: pick.contract.strike,
        expiry: pick.contract.expiry,
      },
    });
    const decided = state.picks?.[leg.key];
    detail = {
      underlying: underlyingRef.symbol,
      contract: symbol,
      words: pick.words,
      listVersion: pick.listVersion,
      ...(decided && decided.contract !== symbol ? { decided } : {}),
    };
    if (decided && state.picks) {
      const { [leg.key]: _done, ...rest } = state.picks;
      void _done;
      state.picks = rest;
    }
  } else {
    // §5.2: an Exit never re-resolves; it closes what its Entry holds.
    const h = heldContract(work, c, order);
    if (!h) return skip(plan, leg);
    contractId = h.id;
    held = h.quantity;
    const ref = work.instruments.get(contractId);
    if (!ref?.option) return skip(plan, leg);
    symbol = ref.symbol;
    detail = {
      underlying: underlyingRef.symbol,
      contract: symbol,
      words: contractInWords({
        underlying: underlyingRef.symbol,
        strike: ref.option.strike,
        right: ref.option.right,
        expiry: ref.option.expiry,
      }),
    };
  }

  // §8.2: one quote, asked now; the gate before anything is sent.
  const quote = await ctx.quotes.optionQuote(symbol);
  const settings = optionsSettings();
  const problem = optionQuoteProblem({
    quote,
    now,
    marketOpen: true,
    maxSpreadPct: settings.maxSpreadPct,
    contract: detail.words,
  });
  const limit = quote ? midLimit(quote) : undefined;
  if (problem || !quote || !limit || limit.lte(0)) {
    const r = problem
      ? refusal(
          problem.code,
          problem.detail.ageSec ?? problem.detail.spreadPct ?? problem.message,
          problem.detail.limitSec ?? problem.detail.limitPct,
        )
      : refusal('option_quote_missing', 'no two-sided quote');
    return refuse(ctx, input, key, contractId, limit ?? ZERO, r, detail);
  }
  detail.quote = { bid: String(quote.bid), ask: String(quote.ask), at: quote.at };

  // §5.1: contracts, or a premium budget in dollars; always rounded down.
  const multiplier =
    work.instruments.get(contractId)?.multiplier ?? String(OPTIONS_DEFAULTS.standardMultiplier);
  const sized = sizeOrder({
    order: { side: order.side, quantity: { ...order.quantity, rounding: 'down' } },
    referencePrice: limit,
    equity: input.equity,
    position: entry ? (c.positions.get(contractId) ?? ZERO) : held,
    lotSize: new Decimal(1),
    multiplier,
  });
  if (!sized.ok) return skip(plan, leg);
  // §8.1: a long option's exposure is the premium paid: limit × 100 × contracts.
  const risk = checkPreTradeRisk({
    risk: def.risk,
    closing: sized.closing,
    quantity: sized.quantity,
    referencePrice: limit,
    limitPrice: limit,
    multiplier,
    activeOrders: input.activeOrders,
    grossExposure: input.gross,
    equity: input.equity,
    dailyLossHit: input.dailyLossHit,
    drawdownHit: input.drawdownHit,
    openPositions: [...work.book.positions.values()].filter((q) => !q.isZero()).length,
    instrumentHeld: !(work.book.positions.get(contractId) ?? ZERO).isZero(),
    account: sized.closing ? undefined : await input.account?.(),
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
    accountId: work.accountId,
    instrumentId: contractId,
    side: order.side,
    direction: sized.direction,
    quantity: sized.quantity.toString(),
    orderType: 'limit',
    limitPrice: limit.toString(),
    stopPrice: undefined,
    timeInForce: order.timeInForce,
    extendedHours: false,
    referencePrice: limit.toString(),
    risk,
    idempotencyKey: key,
    source: 'strategy',
    optionDetail: detail,
  });
  if (!recorded.created || recorded.state !== 'ready') return false;
  if (!sized.closing)
    input.onOpeningRecorded?.(sized.quantity.times(effectivePrice(limit, multiplier)));
  const sent = await ctx.submit(recorded.intentId, {
    clientOrderId: key,
    accountId: work.accountId,
    instrumentId: contractId,
    symbol,
    direction: sized.direction,
    short: false,
    quantity: sized.quantity.toString(),
    orderType: 'limit',
    limitPrice: limit.toString(),
    timeInForce: order.timeInForce,
    extendedHours: false,
    assetClass: 'option',
    positionIntent: positionIntentFor(order.side),
  });
  if (sent) state.orders = { ...state.orders, [recorded.intentId]: { sentAt: now.getTime() } };
  return sent;
}

async function resolveFor(ctx: OptionPassContext, input: OptionLegInput, underlyingSymbol: string) {
  const spec = input.order.option;
  const price = input.underlying?.last;
  if (!spec || !price)
    return {
      ok: false as const,
      code: 'no_price' as const,
      message: `No contract was picked because ${underlyingSymbol} had no price`,
    };
  const today = nyDate(ctx.now);
  const list = await contractListFor(
    ctx,
    { id: input.order.instrumentId, symbol: underlyingSymbol },
    listWindow(spec, price, today),
  );
  const r = resolveContract({
    spec,
    underlying: underlyingSymbol,
    underlyingPrice: price,
    decisionDate: today,
    list: list?.contracts ?? [],
  });
  if (!r.ok || !list)
    return r.ok
      ? {
          ok: false as const,
          code: 'no_list' as const,
          message: `No contract list for ${underlyingSymbol}`,
        }
      : r;
  return {
    ...r,
    listVersion: list.version,
    words: contractInWords({
      underlying: underlyingSymbol,
      strike: r.contract.strike,
      right: r.contract.right,
      expiry: r.contract.expiry,
    }),
  };
}

/** Records an options order refused before it was sent, with its reason in words (§9). */
async function refuse(
  ctx: OptionPassContext,
  input: OptionLegInput,
  key: string,
  instrumentId: string,
  price: Decimal,
  risk: RiskCheckResult,
  detail?: OptionOrderDetail,
): Promise<false> {
  const { order, leg, cycle: c } = input;
  const quantity = order.quantity.type === 'units' ? order.quantity.value : '1';
  await recordOrderIntent(ctx.tx, ctx.work.userId, {
    runtimeId: ctx.work.id,
    strategyId: ctx.work.strategyId,
    versionId: ctx.work.versionId,
    cycleId: c.id,
    phase: leg.phase,
    plannedOrderId: order.id,
    attempt: leg.attempt,
    legLabel: order.legLabel,
    triggerEventId: input.triggerEventId,
    scheduledActionId: undefined,
    eligibleAt: ctx.now.toISOString(),
    accountId: ctx.work.accountId,
    instrumentId,
    side: order.side,
    direction: order.side === 'buy' ? 'buy' : 'sell',
    quantity,
    orderType: 'limit',
    limitPrice: price.gt(0) ? price.toString() : undefined,
    stopPrice: undefined,
    timeInForce: order.timeInForce,
    extendedHours: false,
    referencePrice: price.toString(),
    risk,
    idempotencyKey: key,
    source: 'strategy',
    ...(detail ? { optionDetail: detail } : {}),
  });
  return false;
}

// ---------------------------------------------------------------------------
// §§7.1, 7.4 One re-price, then cancel
// ---------------------------------------------------------------------------

/**
 * Each pass: a working options order not filled `legTimeoutSec` (120 s) after
 * it was sent is re-priced once, from a fresh quote, a third of the way to the
 * touch; still not filled 120 s after that, it is canceled. Lifecycle closes
 * (expiry day) move to the touch on their own schedule and are left alone.
 */
export async function manageOptionOrders(ctx: OptionPassContext): Promise<void> {
  const { work, now, tx } = ctx;
  const state = optionsState(work);
  const timeout = OPTIONS_DEFAULTS.legTimeoutSec * 1000;
  const t = now.getTime();
  const live = new Set<string>();
  for (const o of work.working) {
    const detail = o.intent.optionDetail as OptionOrderDetail | null;
    if (!detail) continue;
    live.add(o.intent.id);
    if (o.cancelRequested || !o.brokerOrderId) continue;
    if (o.state !== 'submitted' && o.state !== 'acknowledged' && o.state !== 'partially_filled')
      continue;
    const rec = state.orders?.[o.intent.id] ?? { sentAt: t };
    state.orders = { ...state.orders, [o.intent.id]: rec };
    if (!regularSessionOpenAt(t)) continue;
    if (detail.lifecycle) {
      // §8.3: an expiry-day close is never canceled; from 15:20 it moves to the touch once.
      const ref = work.instruments.get(o.intent.instrumentId)?.option;
      if (rec.repricedAt !== undefined || !ref || expiryStage(ref.expiry, now) !== 'touch')
        continue;
      const fetched = await ctx.quotes.optionQuote(o.symbol);
      const quote = closeQuoteOk(fetched, now) ? fetched : undefined;
      const touch = quote ? touchLimit(quote, o.intent.direction as 'buy' | 'sell') : undefined;
      if (!quote || !touch || !ctx.broker.replaceOrder) continue;
      await replaceAt(ctx, o, touch, quote, rec);
      continue;
    }
    if (rec.repricedAt === undefined) {
      if (t - rec.sentAt < timeout) continue;
      const quote = await ctx.quotes.optionQuote(o.symbol);
      const problem = optionQuoteProblem({
        quote,
        now,
        marketOpen: true,
        maxSpreadPct: optionsSettings().maxSpreadPct,
        contract: detail.words,
      });
      const limit = quote ? repriceLimit(quote, o.intent.direction as 'buy' | 'sell') : undefined;
      if (problem || !quote || !limit || !ctx.broker.replaceOrder) {
        await requestCancel(
          tx,
          o.intent.id,
          'app',
          problem?.message ?? 'Not filled in time, and no quote to re-price from',
        );
        continue;
      }
      await replaceAt(ctx, o, limit, quote, rec);
    } else if (t - rec.repricedAt >= timeout) {
      await requestCancel(
        tx,
        o.intent.id,
        'app',
        `Canceled: not filled ${OPTIONS_DEFAULTS.legTimeoutSec} seconds after its one re-price`,
      );
    }
  }
  // Orders that ended are forgotten.
  if (state.orders)
    state.orders = Object.fromEntries(Object.entries(state.orders).filter(([id]) => live.has(id)));
}

const quoteDetail = (q: OptionQuote) => ({ bid: String(q.bid), ask: String(q.ask), at: q.at });

/** A close's quote: two-sided and no older than the 60-second limit; any spread. */
const closeQuoteOk = (q: OptionQuote | undefined, now: Date): q is OptionQuote =>
  optionQuoteProblem({ quote: q, now, marketOpen: true, maxSpreadPct: 100_000, contract: '' }) ===
  null;

/** §8.3 at the touch: sell at the bid, buy at the ask. Undefined without a two-sided quote. */
function touchLimit(q: OptionQuote, dir: 'buy' | 'sell'): Decimal | undefined {
  const bid = new Decimal(q.bid);
  const ask = new Decimal(q.ask);
  if (!bid.gt(0) || !ask.gte(bid)) return undefined;
  return dir === 'buy' ? ask : bid;
}

/** Replaces a working options order's limit at the broker, once, and records it. */
async function replaceAt(
  ctx: OptionPassContext,
  o: RuntimeWork['working'][number],
  limit: Decimal,
  quote: OptionQuote,
  rec: { sentAt: number; repricedAt?: number | undefined },
): Promise<void> {
  const state = optionsState(ctx.work);
  const t = ctx.now.getTime();
  const replace = ctx.broker.replaceOrder?.bind(ctx.broker);
  if (!replace || !o.brokerOrderId) return;
  try {
    const r = await replace(ctx.work.accountId, o.brokerOrderId, {
      limitPrice: limit.toString(),
      clientOrderId: repriceClientOrderId(o.intent.idempotencyKey),
    });
    await recordReprice(ctx.tx, o.intent.id, {
      brokerOrderId: r.brokerOrderId,
      limitPrice: limit.toString(),
      quote: quoteDetail(quote),
    });
    state.orders = { ...state.orders, [o.intent.id]: { ...rec, repricedAt: t } };
  } catch (e) {
    if (e instanceof BrokerUnavailableError) return;
    if (!(e instanceof BrokerRejectedError)) throw e;
    // Filled or ended at the broker meanwhile: the next sync says which.
    ctx.logger.info({ intentId: o.intent.id, err: e.message }, 'options re-price refused');
    state.orders = { ...state.orders, [o.intent.id]: { ...rec, repricedAt: t } };
  }
}

// ---------------------------------------------------------------------------
// §8.3 Closing what a cycle holds, and settling what expired
// ---------------------------------------------------------------------------

const flattenKey = (work: RuntimeWork, c: ActiveCycle, instrumentId: string) =>
  idempotencyKey({
    runtimeId: work.id,
    cycleId: c.id,
    phase: 'flatten',
    legId: `flatten-${instrumentId}`,
    attempt: 1,
  });

/**
 * A safety close of a held contract (session end, the strategy trailing stop,
 * expiry day): a limit at the mid, or at the touch from 15:20 on expiry day,
 * never at market. Recorded once per cycle and contract, so calling it again
 * each pass only places it if it has not been placed (e.g. no quote yet).
 * Returns the contract's symbol when an order was placed.
 */
export async function placeOptionFlatten(
  ctx: OptionPassContext,
  input: { cycle: ActiveCycle; instrumentId: string; quantity: Decimal; closeReason: string },
): Promise<string | undefined> {
  const { work, now, tx } = ctx;
  const { cycle: c, instrumentId, quantity } = input;
  const ref = work.instruments.get(instrumentId);
  if (!ref?.option || quantity.isZero() || !regularSessionOpenAt(now.getTime())) return undefined;
  const stage = expiryStage(ref.option.expiry, now);
  if (stage === 'expired') return undefined;
  const fetched = await ctx.quotes.optionQuote(ref.symbol);
  // A safety close goes whatever the spread, but only on a current two-sided quote (§8.2).
  const quote = closeQuoteOk(fetched, now) ? fetched : undefined;
  const direction = quantity.gt(0) ? 'sell' : 'buy';
  const limit = quote
    ? stage === 'touch'
      ? touchLimit(quote, direction)
      : midLimit(quote)
    : undefined;
  if (!quote || !limit || !limit.gt(0)) return undefined;
  const underlying = work.instruments.get(ref.option.underlyingId)?.symbol ?? '';
  const detail: OptionOrderDetail = {
    underlying,
    contract: ref.symbol,
    words: contractInWords({
      underlying,
      strike: ref.option.strike,
      right: ref.option.right,
      expiry: ref.option.expiry,
    }),
    quote: quoteDetail(quote),
    ...(stage === 'close' || stage === 'touch' ? { lifecycle: 'Closed before expiry' } : {}),
  };
  const key = flattenKey(work, c, instrumentId);
  const risk = checkPreTradeRisk({
    risk: {},
    closing: true,
    quantity: quantity.abs(),
    referencePrice: limit,
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
    legLabel: `Close ${detail.words}`.slice(0, 120),
    triggerEventId: undefined,
    scheduledActionId: undefined,
    eligibleAt: now.toISOString(),
    accountId: work.accountId,
    instrumentId,
    side: quantity.gt(0) ? 'sell' : 'buy_to_cover',
    direction,
    quantity: quantity.abs().toString(),
    orderType: 'limit',
    limitPrice: limit.toString(),
    stopPrice: undefined,
    timeInForce: 'day',
    extendedHours: false,
    referencePrice: limit.toString(),
    risk,
    idempotencyKey: key,
    source: 'system',
    closeReason: input.closeReason,
    optionDetail: detail,
  });
  if (!recorded.created || recorded.state !== 'ready') return undefined;
  const sent = await ctx.submit(recorded.intentId, {
    clientOrderId: key,
    accountId: work.accountId,
    instrumentId,
    symbol: ref.symbol,
    direction,
    short: false,
    quantity: quantity.abs().toString(),
    orderType: 'limit',
    limitPrice: limit.toString(),
    timeInForce: 'day',
    extendedHours: false,
    assetClass: 'option',
    positionIntent: direction === 'sell' ? 'sell_to_close' : 'buy_to_close',
  });
  const state = optionsState(work);
  if (sent) {
    // A close placed at the touch has already had its one move.
    const t = now.getTime();
    state.orders = {
      ...state.orders,
      [recorded.intentId]: { sentAt: t, ...(stage === 'touch' ? { repricedAt: t } : {}) },
    };
  }
  return ref.symbol;
}

/** Whether the broker still holds a contract (by the app's instrument id or its symbol). */
const brokerHolds = (held: readonly BrokerPosition[], id: string, symbol: string) =>
  held.some(
    (p) => (p.instrumentId === id || p.instrumentId.endsWith(`:${symbol}`)) && p.quantity !== '0',
  );

/**
 * §8.3 After expiry: a long contract the run still holds that the broker no
 * longer holds, and that was out of the money on the underlying's last price
 * the run saw on its expiry day, expired worthless. It is settled at 0, so the
 * premium paid is the loss, with "Expired worthless" as the exit reason.
 *
 * Anything else is left for reconciliation, which pauses what trades it: a
 * contract that was in the money was exercised and shares may have arrived
 * (Phase O2 builds that flow), and one with no price seen cannot be judged.
 * Runs before reconciliation each pass; returns how many were settled.
 */
export async function settleExpiredOptions(
  tx: Transaction,
  ctx: Pick<OptionPassContext, 'work' | 'broker' | 'now' | 'logger'>,
): Promise<number> {
  const { work, now } = ctx;
  const due: { c: ActiveCycle; id: string; quantity: Decimal }[] = [];
  for (const c of work.cycles)
    for (const [id, q] of c.positions) {
      const ref = work.instruments.get(id);
      if (q.gt(0) && ref?.option && expiryStage(ref.option.expiry, now) === 'expired')
        due.push({ c, id, quantity: q });
    }
  if (due.length === 0) return 0;
  let held: BrokerPosition[];
  try {
    held = await ctx.broker.positions(work.accountId);
  } catch (e) {
    if (e instanceof BrokerUnavailableError) return 0;
    throw e;
  }
  const marks = work.state.options?.expiryMarks ?? {};
  let settled = 0;
  for (const { c, id, quantity } of due) {
    const ref = work.instruments.get(id);
    const option = ref?.option;
    if (!ref || !option) continue;
    if (brokerHolds(held, id, ref.symbol)) continue;
    const mark = marks[id];
    const outOfTheMoney =
      mark !== undefined &&
      (option.right === 'call'
        ? new Decimal(mark).lte(option.strike)
        : new Decimal(mark).gte(option.strike));
    if (!outOfTheMoney) {
      ctx.logger.warn(
        { runtimeId: work.id, contract: ref.symbol, mark },
        'expired option gone from the broker and not known to be worthless: left to reconciliation',
      );
      continue;
    }
    const key = flattenKey(work, c, id);
    const underlying = work.instruments.get(option.underlyingId)?.symbol ?? '';
    const words = contractInWords({
      underlying,
      strike: option.strike,
      right: option.right,
      expiry: option.expiry,
    });
    const recorded = await recordOrderIntent(tx, work.userId, {
      runtimeId: work.id,
      strategyId: work.strategyId,
      versionId: work.versionId,
      cycleId: c.id,
      phase: 'flatten' as PhaseName,
      plannedOrderId: undefined,
      attempt: 1,
      legLabel: `Expired ${words}`.slice(0, 120),
      triggerEventId: undefined,
      scheduledActionId: undefined,
      eligibleAt: now.toISOString(),
      accountId: work.accountId,
      instrumentId: id,
      side: 'sell',
      direction: 'sell',
      quantity: quantity.toString(),
      orderType: 'market',
      limitPrice: undefined,
      stopPrice: undefined,
      timeInForce: 'day',
      extendedHours: false,
      referencePrice: '0',
      risk: { ok: true, checks: [] },
      idempotencyKey: `${key}:expiry`,
      source: 'system',
      closeReason: safetyCloseReason({ kind: 'expired_worthless' }),
      optionDetail: {
        underlying,
        contract: ref.symbol,
        words,
        lifecycle: 'Expired worthless',
      },
    });
    if (!recorded.created) continue;
    // Never sent: the broker already removed the contract. The app records the
    // settlement as the broker's outcome would read, a fill of the whole at 0.
    const at = now.toISOString();
    await markOrderSubmitted(tx, recorded.intentId, `expiry:${recorded.intentId}`);
    await applyBrokerUpdates(
      tx,
      recorded.intentId,
      [
        {
          eventId: `expiry:${recorded.intentId}:accepted`,
          kind: 'accepted',
          rawStatus: 'expired',
          at,
        },
        {
          eventId: `expiry:${recorded.intentId}:settled`,
          kind: 'fill',
          rawStatus: 'expired',
          at,
          fill: { quantity: quantity.toString(), price: '0', fee: '0', kind: 'expiry' },
        },
      ],
      'reconciliation',
    );
    await saveCycle(tx, c.id, {
      ...c.cycle,
      status: c.cycle.status === 'open' ? 'exit_working' : c.cycle.status,
      exitTriggeredAt: c.cycle.exitTriggeredAt ?? now.getTime(),
      exitReason: 'expired_worthless',
      flattened: true,
    });
    settled += 1;
  }
  return settled;
}
