import {
  BrokerRejectedError,
  BrokerUnavailableError,
  type BrokerAdapter,
  type BrokerOrderUpdate,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Transaction } from './client';
import { openIncident, resolveAccountIncidents } from './incidents';
import { accountPositions } from './order-views';
import { applyBrokerUpdates } from './orders';
import { setReconciledAt, WORKING_STATES } from './runtime';
import { brokerOrders, instruments, orderIntents, strategyRuntimes } from './schema';

/**
 * Periodic account reconciliation (Design v1.0 §8.5; ADR 0014). Polls the
 * broker for every order the app thinks is still working and applies what the
 * update stream missed, then compares positions. Anything that still
 * disagrees opens a reconciliation incident and pauses the runtimes trading
 * the instruments involved, because the app can no longer be sure what it
 * holds.
 */

export type Mismatch =
  | { kind: 'missing_at_broker'; intentId: string; brokerOrderId: string }
  | { kind: 'unknown_order'; clientOrderId: string }
  | {
      kind: 'position';
      instrumentId: string;
      symbol: string;
      app: string;
      broker: string;
    };

export interface ReconcileResult {
  /** Missed broker updates that polling recovered. */
  healed: number;
  mismatches: Mismatch[];
  incidentId?: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether an instrument id is one of the app's own. A broker reports a holding
 * the app has no instrument for under a stand-in id such as `alpaca:NKE`.
 */
const isAppInstrument = (id: string) => UUID.test(id);

/** The symbol in a stand-in id (`alpaca:NKE` → `NKE`). */
const standInSymbol = (id: string) => id.slice(id.indexOf(':') + 1) || '?';

/** Unfilled quantity of an instrument's working orders, by side. */
export interface InFlight {
  buy: Decimal;
  sell: Decimal;
}

/**
 * Whether a position gap (broker − app) fits inside what working orders have
 * still to fill: buys can only add to the broker's side, sells only take away.
 */
export function explainedByInFlight(gap: Decimal, inFlight: InFlight | undefined): boolean {
  if (!inFlight) return false;
  return gap.lte(inFlight.buy) && gap.gte(inFlight.sell.negated());
}

/**
 * How long after submission an order may be unknown to the broker before
 * reconciliation calls it missing (N299, ADR 0102). Alpaca answers 404 for an
 * order it never took; at the open it can hold a just-sent order as
 * `pending_new` for many seconds, which reads as no updates yet. Neither means
 * the order is lost until it stays that way.
 */
export const MISSING_GRACE_MS = { notFound: 60_000, noUpdates: 10 * 60_000 } as const;

/**
 * Whether a working order the broker gave nothing back for counts as missing:
 * `notFound` when the broker said it has no such order, otherwise it answered
 * but had nothing to report yet.
 */
export function missingAtBroker(input: {
  notFound: boolean;
  submittedAt: Date | null;
  now: Date;
}): boolean {
  if (!input.submittedAt) return true;
  const age = input.now.getTime() - input.submittedAt.getTime();
  return age >= (input.notFound ? MISSING_GRACE_MS.notFound : MISSING_GRACE_MS.noUpdates);
}

async function inFlightQuantities(
  tx: Transaction,
  accountId: string,
): Promise<Map<string, InFlight>> {
  const rows = await tx
    .select({
      instrumentId: orderIntents.instrumentId,
      direction: orderIntents.direction,
      quantity: orderIntents.quantity,
      filled: brokerOrders.filledQuantity,
    })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .where(
      and(
        eq(orderIntents.accountId, accountId),
        inArray(brokerOrders.state, [...WORKING_STATES]),
        isNotNull(brokerOrders.brokerOrderId),
      ),
    );
  const out = new Map<string, InFlight>();
  for (const r of rows) {
    const left = Decimal.max(0, new Decimal(r.quantity).minus(r.filled));
    const cur = out.get(r.instrumentId) ?? { buy: new Decimal(0), sell: new Decimal(0) };
    if (r.direction === 'buy') cur.buy = cur.buy.plus(left);
    else cur.sell = cur.sell.plus(left);
    out.set(r.instrumentId, cur);
  }
  return out;
}

export async function reconcileAccount(
  tx: Transaction,
  broker: BrokerAdapter,
  input: {
    userId: string;
    accountId: string;
    now: Date;
    /** Broker orders the update stream reported that no app order matches. */
    unknownClientOrderIds?: string[] | undefined;
  },
): Promise<ReconcileResult> {
  const { userId, accountId } = input;
  const mismatches: Mismatch[] = (input.unknownClientOrderIds ?? []).map((clientOrderId) => ({
    kind: 'unknown_order' as const,
    clientOrderId,
  }));

  // 1. Orders: poll each working order and apply anything missed.
  const working = await tx
    .select({
      intentId: orderIntents.id,
      brokerOrderId: brokerOrders.brokerOrderId,
      submittedAt: brokerOrders.submittedAt,
    })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .where(
      and(
        eq(orderIntents.accountId, accountId),
        inArray(brokerOrders.state, [...WORKING_STATES]),
        isNotNull(brokerOrders.brokerOrderId),
      ),
    );
  let healed = 0;
  for (const o of working) {
    const brokerOrderId = o.brokerOrderId as string;
    let updates: BrokerOrderUpdate[];
    let notFound = false;
    try {
      updates = await broker.orderUpdates(accountId, brokerOrderId);
    } catch (e) {
      if (e instanceof BrokerUnavailableError) throw e;
      notFound = e instanceof BrokerRejectedError && e.code === 'not_found';
      updates = [];
    }
    if (updates.length === 0) {
      // Just sent and not yet on the broker's books (Alpaca `pending_new` at the
      // open): look again on the next pass rather than pause (N299).
      if (missingAtBroker({ notFound, submittedAt: o.submittedAt, now: input.now }))
        mismatches.push({ kind: 'missing_at_broker', intentId: o.intentId, brokerOrderId });
      continue;
    }
    healed += (await applyBrokerUpdates(tx, o.intentId, updates, 'reconciliation')).applied;
  }

  // 2. Positions: what the app's fills add up to against what the broker holds.
  // Orders still working can fill at the broker between the poll above and the
  // position read below; a gap they can explain is not a mismatch (N277, ADR 0096).
  const inFlight = await inFlightQuantities(tx, accountId);
  const app = await accountPositions(tx, accountId);
  const held = new Map(
    (await broker.positions(accountId))
      .map((p) => [p.instrumentId, new Decimal(p.quantity)] as const)
      .filter(([, q]) => !q.isZero()),
  );
  const ids = [...new Set([...app.keys(), ...held.keys()])];
  // Only the app's own ids can be looked up; a stand-in carries its symbol.
  const known = ids.filter(isAppInstrument);
  const symbols = new Map<string, string>(
    known.length === 0
      ? []
      : (
          await tx
            .select({ id: instruments.id, symbol: instruments.symbol })
            .from(instruments)
            .where(inArray(instruments.id, known))
        ).map((i) => [i.id, i.symbol]),
  );
  for (const id of ids) if (!isAppInstrument(id)) symbols.set(id, standInSymbol(id));
  for (const id of ids) {
    const a = app.get(id) ?? new Decimal(0);
    const b = held.get(id) ?? new Decimal(0);
    if (!a.equals(b) && !explainedByInFlight(b.minus(a), inFlight.get(id))) {
      mismatches.push({
        kind: 'position',
        instrumentId: id,
        symbol: symbols.get(id) ?? '?',
        app: a.toString(),
        broker: b.toString(),
      });
    }
  }

  await setReconciledAt(tx, userId, accountId, input.now);
  if (healed > 0) {
    await recordAudit(tx, {
      userId,
      actorType: 'system',
      action: 'reconciliation.healed',
      resourceType: 'trading_account',
      resourceId: accountId,
      context: { updates: healed },
    });
  }
  if (mismatches.length === 0) {
    // Everything agrees again: a mismatch found earlier has passed, and the
    // strategies it paused may resume on their own (N301, ADR 0103).
    await resolveAccountIncidents(
      tx,
      userId,
      'reconciliation_mismatch',
      accountId,
      'Reconciliation came back clean',
    );
    return { healed, mismatches };
  }

  // Pause whatever trades the instruments or orders involved (§8.5, §8.6).
  const positionIds = mismatches.flatMap((m) => (m.kind === 'position' ? [m.instrumentId] : []));
  const instrumentIds = positionIds.filter(isAppInstrument);
  const intentIds = mismatches.flatMap((m) => (m.kind === 'missing_at_broker' ? [m.intentId] : []));
  // An order the app did not place, or a holding it has no instrument for, could
  // belong to anything on the account.
  const unknown =
    mismatches.some((m) => m.kind === 'unknown_order') ||
    positionIds.some((id) => !isAppInstrument(id));
  const scope = or(
    instrumentIds.length ? inArray(orderIntents.instrumentId, instrumentIds) : undefined,
    intentIds.length ? inArray(orderIntents.id, intentIds) : undefined,
  );
  const affected = await tx
    .selectDistinct({ runtimeId: orderIntents.runtimeId })
    .from(orderIntents)
    .innerJoin(strategyRuntimes, eq(strategyRuntimes.id, orderIntents.runtimeId))
    .where(
      and(
        eq(orderIntents.accountId, accountId),
        eq(strategyRuntimes.status, 'running'),
        unknown ? undefined : scope,
      ),
    );
  const describe = mismatches
    .slice(0, 3)
    .map((m) =>
      m.kind === 'position'
        ? `${m.symbol}: app ${m.app}, broker ${m.broker}`
        : m.kind === 'missing_at_broker'
          ? 'an order the broker does not know'
          : 'a broker order the app did not place',
    )
    .join('; ');
  const { incidentId } = await openIncident(tx, {
    userId,
    kind: 'reconciliation_mismatch',
    accountId,
    summary: `Reconciliation found ${mismatches.length === 1 ? 'a mismatch' : `${mismatches.length} mismatches`} (${describe}).`,
    details: { mismatches: mismatches.slice(0, 50) },
    pause: affected.map((a) => a.runtimeId),
  });
  return { healed, mismatches, incidentId };
}
