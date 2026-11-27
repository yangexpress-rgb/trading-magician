import {
  ensureOptionInstrument,
  idempotencyKey,
  recordOrderIntent,
  recordReprice,
  requestCancel,
  type ActiveCycle,
  type OptionComboRecord,
  type RuntimeWork,
} from '@tm/db';
import {
  BrokerRejectedError,
  BrokerUnavailableError,
  checkPreTradeRisk,
  comboBuyingPower,
  comboLegClientOrderId,
  comboMaxLoss,
  contractInWords,
  gcd,
  legSign,
  midLimit,
  optionCombos,
  optionQuoteProblem,
  optionsSettings,
  OPTIONS_DEFAULTS,
  regularSessionOpenAt,
  repriceClientOrderId,
  repriceLimit,
  type ComboLeg,
  type DefinitionCombo,
  type OptionOrderDetail,
  type OptionQuote,
  type PlannedOrder,
  type PositionIntent,
  type RiskCheckResult,
  isTerminalOrderState,
} from '@tm/domain';
import Decimal from 'decimal.js';
import {
  optionsState,
  placeOptionFlatten,
  resolveSpec,
  type OptionLegInput,
  type OptionPassContext,
} from './orders';

/**
 * Options combos on paper (options brief v0.2 §§3, 5.5, 7.2–7.4, 8.1; ADR
 * 0123 Phase O2). The options legs of one Entry on one underlying go as one
 * multi-leg order at one net limit, filled all or none. The first of the
 * combo's legs the planner reaches places the whole combo; the others find it
 * placed. An Exit closes everything the cycle holds on that underlying as one
 * order too; if the broker refuses that close, or it is not filled after its
 * one re-price, the contracts close one by one, short legs bought back first,
 * so no moment leaves a short option uncovered.
 */

const ZERO = new Decimal(0);

/** The combo of the definition's Entry that an options leg belongs to, if any. */
export function comboOf(
  def: OptionLegInput['definition'],
  order: PlannedOrder,
): DefinitionCombo | undefined {
  return optionCombos(def.entry.orders).find(
    (c) => c.underlyingId === order.instrumentId && c.accountId === order.accountId,
  );
}

const comboKey = (
  work: RuntimeWork,
  c: ActiveCycle,
  phase: 'entry' | 'exit',
  attempt: number,
  underlyingId: string,
) =>
  idempotencyKey({
    runtimeId: work.id,
    cycleId: c.id,
    phase,
    legId: `combo-${underlyingId}`,
    attempt,
  });

const legByLegKey = (cycleId: string, underlyingId: string) => `${cycleId}|${underlyingId}`;

const sideWords = (sign: 1 | -1, opening: boolean) =>
  opening ? (sign > 0 ? 'Buy' : 'Sell') : sign > 0 ? 'Buy back' : 'Sell';

const intentFor = (sign: 1 | -1, opening: boolean): PositionIntent =>
  opening
    ? sign > 0
      ? 'buy_to_open'
      : 'sell_to_open'
    : sign > 0
      ? 'buy_to_close'
      : 'sell_to_close';

const quoteDetail = (q: OptionQuote) => ({ bid: String(q.bid), ask: String(q.ask), at: q.at });

const refusal = (code: string, value?: string, limit?: string): RiskCheckResult =>
  ({
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
  }) as RiskCheckResult;

interface PricedLeg {
  order: PlannedOrder;
  instrumentId: string;
  symbol: string;
  right: 'call' | 'put';
  strike: string;
  /** Signed contracts per set: + bought, − sold. */
  sign: 1 | -1;
  units: number;
  quote?: OptionQuote | undefined;
  limit?: Decimal | undefined;
  detail: OptionOrderDetail;
}

/**
 * Places a combo leg: the first of the combo's legs places the whole combo;
 * any later one finds it placed. Returns true when the combo reached the
 * broker, false when it waits or was refused, undefined when skipped.
 */
export async function placeComboLeg(
  ctx: OptionPassContext,
  input: OptionLegInput,
  combo: DefinitionCombo,
): Promise<boolean | undefined> {
  return input.leg.phase === 'entry'
    ? placeComboEntry(ctx, input, combo)
    : placeComboExit(ctx, input, combo);
}

async function placeComboEntry(
  ctx: OptionPassContext,
  input: OptionLegInput,
  combo: DefinitionCombo,
): Promise<boolean | undefined> {
  const { work, now, tx } = ctx;
  const { cycle: c, plan, leg, definition: def } = input;
  const state = optionsState(work);
  const key = comboKey(work, c, 'entry', leg.attempt, combo.underlyingId);
  const placed = state.combos?.[key];
  if (placed) return placed.sentAt !== undefined;
  // §6.2: nothing goes while the market is closed; the combo is picked at release.
  if (!regularSessionOpenAt(now.getTime())) {
    if (def.execution.marketHoursPolicy === 'cancel') return skipLeg(plan, leg.key);
    return false;
  }
  const underlying = work.instruments.get(combo.underlyingId);
  const price = input.underlying?.last;
  if (!underlying || !price) return skipLeg(plan, leg.key);

  // §§3, 6: every leg resolves on the expiry the first leg chose.
  const priced: PricedLeg[] = [];
  let expiry: string | undefined;
  // The broker refuses a combo it can't place as one order; no leg goes alone.
  let problem: { code: string; message: string } | undefined = ctx.submitCombo
    ? undefined
    : {
        code: 'options_unsupported',
        message: "This account's broker can't place an options combo as one order",
      };
  for (const o of problem ? [] : combo.legs) {
    const spec = o.option;
    if (!spec) return skipLeg(plan, leg.key);
    const pick = await resolveSpec(
      ctx,
      spec,
      { id: combo.underlyingId, symbol: underlying.symbol },
      price,
      expiry,
    );
    if (!pick.ok) {
      problem = { code: 'option_contract', message: pick.message };
      break;
    }
    expiry ??= pick.contract.expiry;
    const instrumentId = await ensureOptionInstrument(tx, {
      underlyingId: combo.underlyingId,
      symbol: pick.contract.symbol,
      expiry: pick.contract.expiry,
      strike: pick.contract.strike,
      right: pick.contract.right,
      multiplier: pick.contract.multiplier,
      provider: 'alpaca',
      providerId: pick.contract.symbol,
    });
    work.instruments.set(instrumentId, {
      symbol: pick.contract.symbol,
      assetClass: 'option',
      lotSize: '1',
      multiplier: pick.contract.multiplier,
      option: {
        underlyingId: combo.underlyingId,
        right: pick.contract.right,
        strike: pick.contract.strike,
        expiry: pick.contract.expiry,
      },
    });
    priced.push({
      order: o,
      instrumentId,
      symbol: pick.contract.symbol,
      right: pick.contract.right,
      strike: pick.contract.strike,
      sign: legSign(o),
      units: Number(o.quantity.type === 'units' ? o.quantity.value : 0),
      detail: {
        underlying: underlying.symbol,
        contract: pick.contract.symbol,
        words: pick.words,
        listVersion: pick.listVersion,
        ...(pick.greeks ? { greeks: pick.greeks } : {}),
      },
    });
  }

  // §8.2: each leg's quote passes the gate before anything is sent.
  if (!problem) problem = await priceLegs(ctx, priced, true);
  const sets = gcd(priced.map((p) => p.units));
  if (!problem && (sets < 1 || priced.length !== combo.legs.length))
    problem = { code: 'option_contract', message: 'A combo leg has no whole contracts to trade' };
  const comboLegs: ComboLeg[] = priced.map((p) => ({
    right: p.right,
    strike: p.strike,
    quantity: (p.sign * p.units) / Math.max(sets, 1),
  }));
  const net = netOf(priced, sets);
  const multiplier = OPTIONS_DEFAULTS.standardMultiplier;
  const perSetLoss = problem ? undefined : comboMaxLoss(comboLegs, net, multiplier);
  const perSetReserve = problem ? undefined : comboBuyingPower(comboLegs, net, multiplier);
  if (!problem && (perSetLoss === undefined || perSetReserve === undefined))
    problem = {
      code: 'options_naked_call',
      message: 'This combo has no limit to its loss, so it is not placed',
    };
  const atRisk = (perSetLoss ?? ZERO).times(sets);
  const buyingPower = (perSetReserve ?? ZERO).times(sets);
  const words = priced.map((p) => `${sideWords(p.sign, true)} ${p.units} ${p.detail.words}`);
  const comboDetail = {
    legs: words,
    netLimit: net.toString(),
    sets: String(sets),
    maxLoss: atRisk.toFixed(2),
    buyingPower: buyingPower.toFixed(2),
    path: 'combo' as const,
  };

  // §§7.3, 8.1: the order, exposure and account limits see the max loss; buying power the reserve.
  const risk: RiskCheckResult = problem
    ? refusal(problem.code, problem.message)
    : checkPreTradeRisk({
        risk: def.risk,
        closing: false,
        quantity: new Decimal(sets),
        referencePrice: net.abs().gt(0) ? net.abs() : new Decimal('0.01'),
        limitPrice: net.abs(),
        multiplier,
        combo: { atRisk, buyingPower },
        activeOrders: input.activeOrders,
        grossExposure: input.gross,
        equity: input.equity,
        dailyLossHit: input.dailyLossHit,
        drawdownHit: input.drawdownHit,
        openPositions: [...work.book.positions.values()].filter((q) => !q.isZero()).length,
        instrumentHeld: false,
        account: await input.account?.(),
      });

  // Every leg is recorded: all go, or all are refused with the same reason (A4).
  const legs: OptionComboRecord['legs'] = [];
  const allLegs = combo.legs.map((o, i) => priced[i] ?? undefined);
  for (const [i, o] of combo.legs.entries()) {
    const p = allLegs[i];
    const legKey = comboLegClientOrderId(key, p?.symbol ?? `leg${i + 1}`);
    const limit = p?.limit;
    const recorded = await recordOrderIntent(tx, work.userId, {
      runtimeId: work.id,
      strategyId: work.strategyId,
      versionId: work.versionId,
      cycleId: c.id,
      phase: 'entry',
      plannedOrderId: o.id,
      attempt: leg.attempt,
      legLabel: o.legLabel,
      triggerEventId: input.triggerEventId,
      scheduledActionId: undefined,
      eligibleAt: new Date(Math.max(leg.dueAt, 0) || now.getTime()).toISOString(),
      accountId: work.accountId,
      instrumentId: p?.instrumentId ?? combo.underlyingId,
      side: o.side,
      direction: legSign(o) > 0 ? 'buy' : 'sell',
      quantity: String(p?.units ?? (o.quantity.type === 'units' ? o.quantity.value : '1')),
      orderType: 'limit',
      limitPrice: limit && limit.gt(0) ? limit.toString() : undefined,
      stopPrice: undefined,
      timeInForce: o.timeInForce,
      extendedHours: false,
      referencePrice: (limit ?? price).toString(),
      risk,
      idempotencyKey: legKey,
      source: 'strategy',
      orderGroupId: key,
      ...(p
        ? {
            optionDetail: {
              ...p.detail,
              ...(p.quote ? { quote: quoteDetail(p.quote) } : {}),
              combo: comboDetail,
            },
          }
        : {}),
    });
    if (p && recorded.created && recorded.state === 'ready')
      legs.push({
        intentId: recorded.intentId,
        instrumentId: p.instrumentId,
        symbol: p.symbol,
        sign: p.sign,
        ratio: p.units / sets,
      });
  }
  if (!risk.ok || legs.length !== combo.legs.length) return false;
  const record: OptionComboRecord = {
    cycleId: c.id,
    underlyingId: combo.underlyingId,
    phase: 'entry',
    legs,
    sets: String(sets),
    netLimit: net.toString(),
    timeInForce: (combo.legs[0]?.timeInForce ?? 'day') === 'gtc' ? 'gtc' : 'day',
  };
  state.combos = { ...state.combos, [key]: record };
  input.onOpeningRecorded?.(atRisk);
  return sendCombo(ctx, key, record, true);
}

/** Sends a recorded combo; notes when it went. */
async function sendCombo(
  ctx: OptionPassContext,
  key: string,
  record: OptionComboRecord,
  opening: boolean,
): Promise<boolean> {
  if (!ctx.submitCombo) return false;
  const outcome = await ctx.submitCombo(
    record.legs.map((l) => l.intentId),
    {
      clientOrderId: key,
      accountId: ctx.work.accountId,
      legs: record.legs.map((l) => ({
        clientOrderId: comboLegClientOrderId(key, l.symbol),
        instrumentId: l.instrumentId,
        symbol: l.symbol,
        ratio: l.ratio,
        direction: l.sign > 0 ? 'buy' : 'sell',
        positionIntent: intentFor(l.sign, opening),
      })),
      quantity: record.sets,
      limitPrice: record.netLimit,
      timeInForce: record.timeInForce,
    },
  );
  const state = optionsState(ctx.work);
  const t = ctx.now.getTime();
  if (outcome === 'sent') state.combos = { ...state.combos, [key]: { ...record, sentAt: t } };
  if (outcome === 'refused') state.combos = { ...state.combos, [key]: { ...record, refusedAt: t } };
  return outcome === 'sent';
}

/**
 * The Exit of a combo: everything the cycle holds on the underlying closes as
 * one order at the net mid. Each held contract is matched to an Exit leg of
 * the same right that undoes it (a sell for a long, a buy to cover for a
 * short), so each leg's order shows on its own row.
 */
async function placeComboExit(
  ctx: OptionPassContext,
  input: OptionLegInput,
  combo: DefinitionCombo,
): Promise<boolean | undefined> {
  const { work, now, tx } = ctx;
  const { cycle: c, plan, leg, definition: def } = input;
  const state = optionsState(work);
  const key = comboKey(work, c, 'exit', leg.attempt, combo.underlyingId);
  const placed = state.combos?.[key];
  if (placed) return placed.sentAt !== undefined;
  // Closing leg by leg already: those closes finish the job.
  if (state.legByLeg?.[legByLegKey(c.id, combo.underlyingId)]) return false;
  if (!regularSessionOpenAt(now.getTime())) {
    if (def.execution.marketHoursPolicy === 'cancel') return skipLeg(plan, leg.key);
    return false;
  }
  const underlying = work.instruments.get(combo.underlyingId);
  if (!underlying) return skipLeg(plan, leg.key);
  const exitLegs = def.exit.orders.filter(
    (o) => o.option && o.instrumentId === combo.underlyingId && o.accountId === combo.accountId,
  );
  const held = [...c.positions]
    .filter(
      ([id, q]) =>
        !q.isZero() && work.instruments.get(id)?.option?.underlyingId === combo.underlyingId,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (held.length === 0) return skipLeg(plan, leg.key);

  // Match each held contract to an Exit leg that undoes it.
  const claimed = new Set<string>();
  const priced: PricedLeg[] = [];
  for (const [id, q] of held) {
    const ref = work.instruments.get(id);
    const option = ref?.option;
    if (!ref || !option) continue;
    const long = q.gt(0);
    const exit = exitLegs.find(
      (o) =>
        !claimed.has(o.id) &&
        o.option?.right === option.right &&
        (o.side === 'close' || o.side === (long ? 'sell' : 'buy_to_cover')),
    );
    if (!exit) {
      // A held contract no Exit leg undoes: close everything leg by leg instead.
      await startLegByLeg(
        ctx,
        c,
        combo.underlyingId,
        'An Exit leg for each contract held was not found',
      );
      return false;
    }
    claimed.add(exit.id);
    priced.push({
      order: exit,
      instrumentId: id,
      symbol: ref.symbol,
      right: option.right,
      strike: option.strike,
      // Closing undoes the holding: sell a long (−), buy back a short (+).
      sign: long ? -1 : 1,
      units: q.abs().toNumber(),
      detail: {
        underlying: underlying.symbol,
        contract: ref.symbol,
        words: contractInWords({
          underlying: underlying.symbol,
          strike: option.strike,
          right: option.right,
          expiry: option.expiry,
        }),
      },
    });
  }
  // The planner places each Exit leg; only the first acts for the combo.
  const problem = await priceLegs(ctx, priced, false);
  const sets = gcd(priced.map((p) => p.units));
  const net = netOf(priced, sets);
  const words = priced.map((p) => `${sideWords(p.sign, false)} ${p.units} ${p.detail.words}`);
  const comboDetail = {
    legs: words,
    netLimit: net.toString(),
    sets: String(sets),
    path: 'combo' as const,
  };
  const risk: RiskCheckResult = problem
    ? refusal(problem.code, problem.message)
    : { ok: true, checks: [] };
  const legs: OptionComboRecord['legs'] = [];
  for (const p of priced) {
    const recorded = await recordOrderIntent(tx, work.userId, {
      runtimeId: work.id,
      strategyId: work.strategyId,
      versionId: work.versionId,
      cycleId: c.id,
      phase: 'exit',
      plannedOrderId: p.order.id,
      attempt: leg.attempt,
      legLabel: p.order.legLabel,
      triggerEventId: input.triggerEventId,
      scheduledActionId: undefined,
      eligibleAt: now.toISOString(),
      accountId: work.accountId,
      instrumentId: p.instrumentId,
      side: p.sign > 0 ? 'buy_to_cover' : 'sell',
      direction: p.sign > 0 ? 'buy' : 'sell',
      quantity: String(p.units),
      orderType: 'limit',
      limitPrice: p.limit && p.limit.gt(0) ? p.limit.toString() : undefined,
      stopPrice: undefined,
      timeInForce: 'day',
      extendedHours: false,
      referencePrice: (p.limit ?? ZERO).toString(),
      risk,
      idempotencyKey: comboLegClientOrderId(key, p.symbol),
      source: 'strategy',
      orderGroupId: key,
      optionDetail: {
        ...p.detail,
        ...(p.quote ? { quote: quoteDetail(p.quote) } : {}),
        combo: comboDetail,
      },
    });
    if (recorded.created && recorded.state === 'ready')
      legs.push({
        intentId: recorded.intentId,
        instrumentId: p.instrumentId,
        symbol: p.symbol,
        sign: p.sign,
        ratio: p.units / sets,
      });
  }
  if (!risk.ok || legs.length !== priced.length) return false;
  const record: OptionComboRecord = {
    cycleId: c.id,
    underlyingId: combo.underlyingId,
    phase: 'exit',
    legs,
    sets: String(sets),
    netLimit: net.toString(),
    timeInForce: 'day',
  };
  state.combos = { ...state.combos, [key]: record };
  return sendCombo(ctx, key, record, false);
}

/** One quote per leg, gated (§8.2); each leg's limit at its mid. A problem refuses them all. */
async function priceLegs(
  ctx: OptionPassContext,
  legs: PricedLeg[],
  opening: boolean,
): Promise<{ code: string; message: string } | undefined> {
  const settings = optionsSettings();
  for (const p of legs) {
    const quote = await ctx.quotes.optionQuote(p.symbol);
    const problem = optionQuoteProblem({
      quote,
      now: ctx.now,
      marketOpen: true,
      maxSpreadPct: settings.maxSpreadPct,
      contract: p.detail.words,
    });
    const limit = quote ? midLimit(quote) : undefined;
    if (problem) return { code: problem.code, message: problem.message };
    if (!quote || !limit || (opening && limit.lte(0)))
      return { code: 'option_quote_missing', message: `${p.detail.words} had no two-sided quote` };
    p.quote = quote;
    p.limit = limit;
  }
  return undefined;
}

/** Net per share of one set, to the cent: + paid, − received. */
function netOf(legs: readonly PricedLeg[], sets: number): Decimal {
  if (sets < 1) return ZERO;
  return legs
    .reduce((sum, p) => sum.plus((p.limit ?? ZERO).times(p.sign * (p.units / sets))), ZERO)
    .toDecimalPlaces(2);
}

const skipLeg = (plan: OptionLegInput['plan'], key: string): undefined => {
  if (!plan.cycle.skipped.includes(key)) plan.cycle.skipped.push(key);
  return undefined;
};

// ---------------------------------------------------------------------------
// §§7.2, 7.4 Each pass: resend, one re-price, cancel, and the leg-by-leg close
// ---------------------------------------------------------------------------

/**
 * Each pass, for each combo the run placed:
 * - recorded but never sent (the broker was unreachable): sent again, same key;
 * - not filled 120 s after it was sent: re-priced once, every leg a third of
 *   the way to its touch, so the net moves the same way;
 * - not filled 120 s after that: canceled.
 * A combo close that was refused or canceled with nothing filled starts the
 * leg-by-leg close, short legs first; safety closes waiting for a short leg
 * to be bought back are placed once it is.
 */
export async function manageCombos(ctx: OptionPassContext): Promise<void> {
  const { work, now, tx } = ctx;
  const state = optionsState(work);
  const t = now.getTime();
  const timeout = OPTIONS_DEFAULTS.legTimeoutSec * 1000;
  const records = Object.entries(state.combos ?? {});
  const legState = new Map<string, { state: string; filled: Decimal }>();
  for (const c of work.cycles)
    for (const l of c.legs) legState.set(l.intentId, { state: l.state, filled: l.filled });
  const working = new Map(work.working.map((o) => [o.intent.id, o]));
  const keep: Record<string, OptionComboRecord> = {};
  for (const [key, rec] of records) {
    const cycle = work.cycles.find((c) => c.id === rec.cycleId);
    const live = rec.legs.filter((l) => working.has(l.intentId));
    if (!cycle) continue;
    if (live.length === 0) {
      // Ended. A close that filled nothing goes leg by leg, short legs first.
      const filledAny = rec.legs.some((l) => (legState.get(l.intentId)?.filled ?? ZERO).gt(0));
      const went = rec.sentAt !== undefined || rec.refusedAt !== undefined;
      if (rec.phase === 'exit' && went && !filledAny) {
        await startLegByLeg(
          ctx,
          cycle,
          rec.underlyingId,
          'The combo close was refused or not filled in time, so each leg closes on its own, short legs first',
        );
      }
      continue;
    }
    keep[key] = rec;
    if (!regularSessionOpenAt(t)) continue;
    const first = working.get(live[0]?.intentId ?? '');
    if (!first) continue;
    if (first.state === 'ready') {
      // Never reached the broker: send again with the same key (§8.5).
      await sendCombo(ctx, key, rec, rec.phase === 'entry');
      continue;
    }
    if (first.cancelRequested || !first.brokerOrderId) continue;
    const sentAt = rec.sentAt ?? t;
    if (rec.sentAt === undefined) keep[key] = { ...rec, sentAt };
    if (rec.repricedAt === undefined) {
      if (t - sentAt < timeout) continue;
      const moved = await repriceCombo(ctx, key, rec, first.brokerOrderId);
      if (moved === 'canceled') {
        for (const l of live)
          await requestCancel(
            tx,
            l.intentId,
            'app',
            'Not filled in time, and no quote to re-price from',
          );
      }
      keep[key] = { ...(state.combos?.[key] ?? rec), repricedAt: t };
    } else if (t - rec.repricedAt >= timeout) {
      for (const l of live)
        await requestCancel(
          tx,
          l.intentId,
          'app',
          `Canceled: not filled ${OPTIONS_DEFAULTS.legTimeoutSec} seconds after its one re-price`,
        );
    }
  }
  state.combos = keep;
  await placeLegByLeg(ctx);
}

/** §7.1 for a combo: every leg a third of the way to its touch, one replace of the whole order. */
async function repriceCombo(
  ctx: OptionPassContext,
  key: string,
  rec: OptionComboRecord,
  brokerOrderId: string,
): Promise<'moved' | 'canceled' | 'refused'> {
  const replace = ctx.broker.replaceOrder?.bind(ctx.broker);
  if (!replace) return 'canceled';
  const quotes: { leg: OptionComboRecord['legs'][number]; quote: OptionQuote; limit: Decimal }[] =
    [];
  for (const l of rec.legs) {
    const quote = await ctx.quotes.optionQuote(l.symbol);
    const problem = optionQuoteProblem({
      quote,
      now: ctx.now,
      marketOpen: true,
      // A close is re-priced on any spread; an opening only within the gate (§8.2).
      maxSpreadPct: rec.phase === 'exit' ? 100_000 : optionsSettings().maxSpreadPct,
      contract: l.symbol,
    });
    const limit = quote && !problem ? repriceLimit(quote, l.sign > 0 ? 'buy' : 'sell') : undefined;
    if (!quote || !limit) return 'canceled';
    quotes.push({ leg: l, quote, limit });
  }
  const net = quotes
    .reduce((s, q) => s.plus(q.limit.times(q.leg.sign * q.leg.ratio)), ZERO)
    .toDecimalPlaces(2);
  try {
    const r = await replace(ctx.work.accountId, brokerOrderId, {
      limitPrice: net.toString(),
      clientOrderId: repriceClientOrderId(key),
    });
    for (const q of quotes)
      await recordReprice(ctx.tx, q.leg.intentId, {
        brokerOrderId: r.brokerOrderId,
        limitPrice: q.limit.toString(),
        quote: quoteDetail(q.quote),
      });
    const state = optionsState(ctx.work);
    state.combos = { ...state.combos, [key]: { ...rec, netLimit: net.toString() } };
    return 'moved';
  } catch (e) {
    if (e instanceof BrokerUnavailableError) return 'refused';
    if (!(e instanceof BrokerRejectedError)) throw e;
    ctx.logger.info({ combo: key, err: e.message }, 'options combo re-price refused');
    return 'refused';
  }
}

/**
 * Whether a close of this contract is working in the cycle. One that ended
 * unfilled (canceled after its re-price) no longer counts, so the contract is
 * closed again (staging check, 2026-11-27).
 */
const closing = (cycle: ActiveCycle, instrumentId: string) =>
  cycle.legs.some(
    (l) =>
      l.phase === 'flatten' && l.instrumentId === instrumentId && !isTerminalOrderState(l.state),
  );

/** Starts closing a cycle's contracts on an underlying one by one, short legs first. */
async function startLegByLeg(
  ctx: OptionPassContext,
  cycle: ActiveCycle,
  underlyingId: string,
  reason: string,
): Promise<void> {
  const state = optionsState(ctx.work);
  const k = legByLegKey(cycle.id, underlyingId);
  if (state.legByLeg?.[k]) return;
  state.legByLeg = { ...state.legByLeg, [k]: reason };
  ctx.logger.info(
    { runtimeId: ctx.work.id, cycleId: cycle.id },
    'options combo closing leg by leg',
  );
}

/**
 * The leg-by-leg close (§7.4): each contract held on the underlying closes
 * as a limit, short legs bought back before any long leg is sold.
 * `placeOptionFlatten` defers a long while a short is held, so calling this
 * each pass sells the longs once the shorts are gone.
 */
async function placeLegByLeg(ctx: OptionPassContext): Promise<void> {
  const state = optionsState(ctx.work);
  const done: string[] = [];
  for (const [k, reason] of Object.entries(state.legByLeg ?? {})) {
    const [cycleId, underlyingId] = k.split('|');
    const cycle = ctx.work.cycles.find((c) => c.id === cycleId);
    if (!cycle) {
      done.push(k);
      continue;
    }
    const held = [...cycle.positions].filter(
      ([id, q]) =>
        !q.isZero() && ctx.work.instruments.get(id)?.option?.underlyingId === underlyingId,
    );
    // Short legs first: their buy-backs are placed before any long is sold.
    held.sort(([, a], [, b]) => a.cmp(b));
    for (const [instrumentId, quantity] of held.filter(([id]) => !closing(cycle, id)))
      await placeOptionFlatten(ctx, {
        cycle,
        instrumentId,
        quantity,
        closeReason: reason,
        path: 'legs_short_first',
      });
  }
  for (const [cycleId, reason] of Object.entries(state.pendingCloses ?? {})) {
    const cycle = ctx.work.cycles.find((c) => c.id === cycleId);
    if (!cycle) {
      done.push(`pending:${cycleId}`);
      continue;
    }
    for (const [instrumentId, quantity] of cycle.positions)
      if (
        !quantity.isZero() &&
        !closing(cycle, instrumentId) &&
        ctx.work.instruments.get(instrumentId)?.assetClass === 'option'
      )
        await placeOptionFlatten(ctx, { cycle, instrumentId, quantity, closeReason: reason });
  }
  const gone = new Set(done);
  if (state.legByLeg)
    state.legByLeg = Object.fromEntries(
      Object.entries(state.legByLeg).filter(([k]) => !gone.has(k)),
    );
  if (state.pendingCloses)
    state.pendingCloses = Object.fromEntries(
      Object.entries(state.pendingCloses).filter(([k]) => !gone.has(`pending:${k}`)),
    );
}
