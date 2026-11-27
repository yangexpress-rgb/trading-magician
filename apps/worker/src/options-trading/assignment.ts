import {
  applyBrokerUpdates,
  idempotencyKey,
  markOrderSubmitted,
  recordAudit,
  recordOrderIntent,
  type ActiveCycle,
  type RuntimeWork,
  type Transaction,
} from '@tm/db';
import {
  BrokerRejectedError,
  BrokerUnavailableError,
  contractInWords,
  nyDate,
  safetyCloseReason,
  type BrokerAdapter,
  type BrokerPosition,
  type PhaseName,
} from '@tm/domain';
import Decimal from 'decimal.js';
import type { Logger } from 'pino';
import { optionsState } from './orders';

/**
 * Assignment (options brief v0.2 §8.3, ADR 0123 Phase O2). A short leg of a
 * combo can be assigned on any day, and Alpaca posts its record of it only
 * the next morning. So the app infers it, before reconciliation looks, from
 * what the broker holds: the short contract gone (or fewer), and 100 shares a
 * contract of the underlying delivered at the strike (sold for a call, bought
 * for a put). Both are recorded as the cycle's own fills of kind
 * `assignment`, so equity, the cycle's P&L and reconciliation all see them;
 * the cycle is flagged, and its planner closes the rest of the combo and the
 * shares in the regular session. The next morning the broker's activity
 * record confirms the assignment, or the cycle is flagged as unconfirmed.
 *
 * Anything that does not add up (shares that don't match, a contract gone
 * with no shares) is left to reconciliation, which pauses what trades it.
 */

type Ctx = {
  work: RuntimeWork;
  broker: BrokerAdapter;
  now: Date;
  logger: Pick<Logger, 'info' | 'warn'>;
};

const ZERO = new Decimal(0);

/** What the broker holds of an instrument (by the app's id, its stand-in, or its symbol). */
const brokerQuantity = (held: readonly BrokerPosition[], id: string, symbol: string) =>
  held
    .filter(
      (p) =>
        p.instrumentId === id || p.instrumentId === symbol || p.instrumentId.endsWith(`:${symbol}`),
    )
    .reduce((s, p) => s.plus(p.quantity), ZERO);

export async function settleAssignedOptions(tx: Transaction, ctx: Ctx): Promise<number> {
  const { work, now } = ctx;
  const due: { c: ActiveCycle; id: string; quantity: Decimal }[] = [];
  for (const c of work.cycles)
    for (const [id, q] of c.positions)
      if (q.lt(0) && work.instruments.get(id)?.option) due.push({ c, id, quantity: q });
  if (due.length === 0) return 0;
  let held: BrokerPosition[];
  try {
    held = await ctx.broker.positions(work.accountId);
  } catch (e) {
    if (e instanceof BrokerUnavailableError) return 0;
    throw e;
  }
  const state = optionsState(work);
  // Shares already explained this pass, by underlying.
  const explained = new Map<string, Decimal>();
  let settled = 0;
  for (const { c, id, quantity } of due) {
    const ref = work.instruments.get(id);
    const option = ref?.option;
    const underlying = option ? work.instruments.get(option.underlyingId) : undefined;
    if (!ref || !option || !underlying) continue;
    const book = work.book.positions.get(id) ?? ZERO;
    const atBroker = brokerQuantity(held, id, ref.symbol);
    // Fewer contracts short at the broker than the run holds: some were assigned.
    if (!book.lt(0) || !atBroker.gt(book)) continue;
    const contracts = Decimal.min(atBroker.minus(book), quantity.abs());
    if (!contracts.isInteger() || contracts.lte(0)) continue;
    const shares = contracts.times(ref.multiplier ?? '100');
    const call = option.right === 'call';
    // Shares the broker holds that the run's book doesn't, net of any explained already.
    const bookShares = work.book.positions.get(option.underlyingId) ?? ZERO;
    const brokerShares = brokerQuantity(held, option.underlyingId, underlying.symbol);
    const unexplained = brokerShares
      .minus(bookShares)
      .minus(explained.get(option.underlyingId) ?? ZERO);
    const expected = call ? shares.neg() : shares;
    if (!unexplained.eq(expected)) {
      ctx.logger.warn(
        { runtimeId: work.id, contract: ref.symbol, unexplained: unexplained.toString() },
        'short option gone from the broker without the shares an assignment delivers: left to reconciliation',
      );
      continue;
    }
    explained.set(option.underlyingId, (explained.get(option.underlyingId) ?? ZERO).plus(expected));
    const words = contractInWords({
      underlying: underlying.symbol,
      strike: option.strike,
      right: option.right,
      expiry: option.expiry,
    });
    const detail = `${contracts} ${words} sold in this ${work.definition.entry.orders.filter((o) => o.option).length > 1 ? 'combo' : 'cycle'} ${contracts.eq(1) ? 'was' : 'were'} assigned, so ${shares} ${underlying.symbol} shares were ${call ? 'sold' : 'bought'} at ${option.strike}`;
    const closeReason = safetyCloseReason({ kind: 'assigned', detail });
    const base = idempotencyKey({
      runtimeId: work.id,
      cycleId: c.id,
      phase: 'flatten',
      legId: `assigned-${id}`,
      attempt: 1,
    });
    const at = now.toISOString();
    const record = async (input: {
      key: string;
      instrumentId: string;
      side: 'buy_to_cover' | 'sell_short' | 'sell' | 'buy';
      direction: 'buy' | 'sell';
      quantity: Decimal;
      price: string;
      label: string;
      optionDetail?: Parameters<typeof recordOrderIntent>[2]['optionDetail'];
    }) => {
      const recorded = await recordOrderIntent(tx, work.userId, {
        runtimeId: work.id,
        strategyId: work.strategyId,
        versionId: work.versionId,
        cycleId: c.id,
        phase: 'flatten' as PhaseName,
        plannedOrderId: undefined,
        attempt: 1,
        legLabel: input.label.slice(0, 120),
        triggerEventId: undefined,
        scheduledActionId: undefined,
        eligibleAt: at,
        accountId: work.accountId,
        instrumentId: input.instrumentId,
        side: input.side,
        direction: input.direction,
        quantity: input.quantity.toString(),
        orderType: 'market',
        limitPrice: undefined,
        stopPrice: undefined,
        timeInForce: 'day',
        extendedHours: false,
        referencePrice: input.price,
        risk: { ok: true, checks: [] },
        idempotencyKey: input.key,
        source: 'system',
        closeReason,
        ...(input.optionDetail ? { optionDetail: input.optionDetail } : {}),
      });
      if (!recorded.created) return false;
      // Never sent: the broker already did it. Recorded as its outcome reads.
      await markOrderSubmitted(tx, recorded.intentId, `assignment:${recorded.intentId}`);
      await applyBrokerUpdates(
        tx,
        recorded.intentId,
        [
          {
            eventId: `assignment:${recorded.intentId}:accepted`,
            kind: 'accepted',
            rawStatus: 'assigned',
            at,
          },
          {
            eventId: `assignment:${recorded.intentId}:fill`,
            kind: 'fill',
            rawStatus: 'assigned',
            at,
            fill: {
              quantity: input.quantity.toString(),
              price: input.price,
              fee: '0',
              kind: 'assignment',
            },
          },
        ],
        'reconciliation',
      );
      return true;
    };
    // The contract leaves at 0; the premium taken in stays the cycle's.
    const done = await record({
      key: `${base}:contract`,
      instrumentId: id,
      side: 'buy_to_cover',
      direction: 'buy',
      quantity: contracts,
      price: '0',
      label: `Assigned ${words}`,
      optionDetail: {
        underlying: underlying.symbol,
        contract: ref.symbol,
        words,
        lifecycle: 'Assigned',
      },
    });
    if (!done) continue;
    // The shares, at the strike, attributed to the same cycle.
    // A covered call's own shares are sold (Phase O3); a combo's call sells short.
    const cycleShares = c.positions.get(option.underlyingId) ?? ZERO;
    await record({
      key: `${base}:shares`,
      instrumentId: option.underlyingId,
      side: call ? (cycleShares.gte(shares) ? 'sell' : 'sell_short') : 'buy',
      direction: call ? 'sell' : 'buy',
      quantity: shares,
      price: new Decimal(option.strike).toString(),
      label: `${call ? 'Sold' : 'Bought'} ${shares} ${underlying.symbol} on assignment`,
    });
    state.assigned = {
      ...state.assigned,
      [c.id]: { symbol: ref.symbol, quantity: contracts.toString(), at, detail },
    };
    await recordAudit(tx, {
      userId: work.userId,
      actorType: 'system',
      action: 'options.assigned',
      resourceType: 'strategy_runtime',
      resourceId: work.id,
      context: {
        cycleId: c.id,
        contract: ref.symbol,
        contracts: contracts.toString(),
        shares: shares.toString(),
      },
    });
    ctx.logger.info({ runtimeId: work.id, contract: ref.symbol }, 'options assignment recorded');
    settled += 1;
  }
  return settled;
}

/**
 * The morning after (§8.3): each assignment the app inferred is checked
 * against the broker's activity record. Found, it is confirmed; missing, the
 * cycle is flagged so the order detail says the broker hasn't confirmed it.
 * Assignments of cycles that have ended and been checked are forgotten.
 */
export async function confirmAssignments(tx: Transaction, ctx: Ctx): Promise<void> {
  const { work, now } = ctx;
  const state = optionsState(work);
  const today = nyDate(now);
  const open = new Set(work.cycles.map((c) => c.id));
  for (const [cycleId, a] of Object.entries(state.assigned ?? {})) {
    if (a.confirmedAt || a.unconfirmed) {
      if (!open.has(cycleId)) {
        const { [cycleId]: _gone, ...rest } = state.assigned ?? {};
        void _gone;
        state.assigned = rest;
      }
      continue;
    }
    const day = nyDate(new Date(a.at));
    if (today <= day || !ctx.broker.optionActivities) continue;
    let found = false;
    try {
      const acts = await ctx.broker.optionActivities(work.accountId, day);
      found = acts.some((x) => x.kind === 'assignment' && x.symbol === a.symbol);
    } catch (e) {
      if (e instanceof BrokerUnavailableError) continue;
      if (!(e instanceof BrokerRejectedError)) throw e;
    }
    state.assigned = {
      ...state.assigned,
      [cycleId]: found
        ? { ...a, confirmedAt: now.toISOString() }
        : {
            ...a,
            unconfirmed:
              "The broker's activity record doesn't show this assignment yet; check the account",
          },
    };
    if (!found) {
      ctx.logger.warn(
        { runtimeId: work.id, contract: a.symbol },
        'options assignment not confirmed',
      );
      await recordAudit(tx, {
        userId: work.userId,
        actorType: 'system',
        action: 'options.assignment_unconfirmed',
        resourceType: 'strategy_runtime',
        resourceId: work.id,
        context: { cycleId, contract: a.symbol },
      });
    }
  }
}
