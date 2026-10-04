import { BrokerUnavailableError, type BrokerAdapter, type BrokerOrderUpdate } from '@tm/domain';
import Decimal from 'decimal.js';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Transaction } from './client';
import { openIncident } from './incidents';
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
    .select({ intentId: orderIntents.id, brokerOrderId: brokerOrders.brokerOrderId })
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
    try {
      updates = await broker.orderUpdates(accountId, brokerOrderId);
    } catch (e) {
      if (e instanceof BrokerUnavailableError) throw e;
      updates = [];
    }
    if (updates.length === 0) {
      mismatches.push({ kind: 'missing_at_broker', intentId: o.intentId, brokerOrderId });
      continue;
    }
    healed += (await applyBrokerUpdates(tx, o.intentId, updates, 'reconciliation')).applied;
  }

  // 2. Positions: what the app's fills add up to against what the broker holds.
  const app = await accountPositions(tx, accountId);
  const held = new Map(
    (await broker.positions(accountId))
      .map((p) => [p.instrumentId, new Decimal(p.quantity)] as const)
      .filter(([, q]) => !q.isZero()),
  );
  const ids = [...new Set([...app.keys(), ...held.keys()])];
  const symbols = new Map(
    ids.length === 0
      ? []
      : (
          await tx
            .select({ id: instruments.id, symbol: instruments.symbol })
            .from(instruments)
            .where(inArray(instruments.id, ids))
        ).map((i) => [i.id, i.symbol]),
  );
  for (const id of ids) {
    const a = app.get(id) ?? new Decimal(0);
    const b = held.get(id) ?? new Decimal(0);
    if (!a.equals(b)) {
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
  if (mismatches.length === 0) return { healed, mismatches };

  // Pause whatever trades the instruments or orders involved (§8.5, §8.6).
  const instrumentIds = mismatches.flatMap((m) => (m.kind === 'position' ? [m.instrumentId] : []));
  const intentIds = mismatches.flatMap((m) => (m.kind === 'missing_at_broker' ? [m.intentId] : []));
  const unknown = mismatches.some((m) => m.kind === 'unknown_order');
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
        // A broker order the app did not place could belong to anything on the account.
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
