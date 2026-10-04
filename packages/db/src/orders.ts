import { createHash } from 'node:crypto';
import {
  deriveBrokerOrder,
  idempotencySeed,
  isTerminalOrderState,
  transitionOrder,
  type BrokerUpdate,
  type IdempotencyParts,
  type OrderIntent,
  type OrderState,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { and, asc, eq } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Transaction } from './client';
import { brokerOrders, fills, orderEvents, orderIntents } from './schema';

/**
 * Order intents and their broker-side state (Design v1.0 §8.2–8.5; ADR 0010).
 *
 * An intent is written once and never changed. Its current state lives in
 * `broker_order`, which only this module updates, always while holding that
 * row's lock. Broker updates are stored as they arrive and the state is then
 * derived from all of them, so retries, duplicates and out-of-order delivery
 * converge on the same answer.
 */

export class OrderError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_state',
    message: string,
  ) {
    super(message);
    this.name = 'OrderError';
  }
}

/**
 * A deterministic, broker-safe client order id (§8.5): 36 characters, so it fits
 * every common broker's client-order-id limit.
 */
export function idempotencyKey(parts: IdempotencyParts): string {
  return `tm1-${createHash('sha256').update(idempotencySeed(parts)).digest('hex').slice(0, 32)}`;
}

export interface RecordedIntent {
  intentId: string;
  /** False when an intent with the same idempotency key already existed. */
  created: boolean;
  state: OrderState;
}

/**
 * Stores an intent whose risk check has just run. An intent that passed is
 * `ready` to submit; one that failed is `rejected` and never reaches a broker.
 * Recording the same idempotency key twice returns the first intent unchanged.
 */
export async function recordOrderIntent(
  tx: Transaction,
  userId: string,
  intent: OrderIntent,
): Promise<RecordedIntent> {
  const [row] = await tx
    .insert(orderIntents)
    .values({
      userId,
      runtimeId: intent.runtimeId,
      strategyId: intent.strategyId,
      versionId: intent.versionId,
      cycleId: intent.cycleId,
      phase: intent.phase,
      plannedOrderId: intent.plannedOrderId ?? null,
      attempt: intent.attempt,
      legLabel: intent.legLabel,
      triggerEventId: intent.triggerEventId ?? null,
      scheduledActionId: intent.scheduledActionId ?? null,
      eligibleAt: new Date(intent.eligibleAt),
      accountId: intent.accountId,
      instrumentId: intent.instrumentId,
      side: intent.side,
      direction: intent.direction,
      quantity: intent.quantity,
      orderType: intent.orderType,
      limitPrice: intent.limitPrice ?? null,
      stopPrice: intent.stopPrice ?? null,
      timeInForce: intent.timeInForce,
      extendedHours: intent.extendedHours,
      referencePrice: intent.referencePrice,
      risk: intent.risk,
      idempotencyKey: intent.idempotencyKey,
      source: intent.source,
    })
    .onConflictDoNothing({ target: [orderIntents.userId, orderIntents.idempotencyKey] })
    .returning({ id: orderIntents.id });

  if (!row) {
    const [existing] = await tx
      .select({ id: orderIntents.id, state: brokerOrders.state })
      .from(orderIntents)
      .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
      .where(
        and(
          eq(orderIntents.userId, userId),
          eq(orderIntents.idempotencyKey, intent.idempotencyKey),
        ),
      );
    if (!existing) throw new OrderError('not_found', 'The existing order could not be read');
    return { intentId: existing.id, created: false, state: existing.state };
  }

  // Planned → pending risk check → ready or rejected, all within this transaction.
  const pending = transitionOrder('planned', 'pending_risk');
  const state = transitionOrder(pending, intent.risk.ok ? 'ready' : 'rejected');
  const now = new Date();
  await tx.insert(brokerOrders).values({
    intentId: row.id,
    userId,
    state,
    reason: intent.risk.ok ? null : `Risk check failed: ${intent.risk.code ?? 'unknown'}`,
    terminalAt: state === 'rejected' ? now : null,
  });
  await tx.insert(orderEvents).values({
    userId,
    intentId: row.id,
    source: 'app',
    fromState: 'planned',
    toState: state,
    payload: { kind: 'risk_check', risk: intent.risk },
  });
  await recordAudit(tx, {
    userId,
    actorType: intent.source === 'user' ? 'user' : 'system',
    action: intent.risk.ok ? 'order.risk_approved' : 'order.risk_rejected',
    resourceType: 'order_intent',
    resourceId: row.id,
    context: {
      runtimeId: intent.runtimeId,
      cycleId: intent.cycleId,
      phase: intent.phase,
      riskCode: intent.risk.code ?? null,
    },
  });
  return { intentId: row.id, created: true, state };
}

async function lockOrder(tx: Transaction, intentId: string) {
  const [row] = await tx
    .select({
      state: brokerOrders.state,
      quantity: orderIntents.quantity,
      userId: brokerOrders.userId,
    })
    .from(brokerOrders)
    .innerJoin(orderIntents, eq(orderIntents.id, brokerOrders.intentId))
    .where(eq(brokerOrders.intentId, intentId))
    .for('update', { of: brokerOrders });
  if (!row) throw new OrderError('not_found', 'Order not found');
  return row;
}

/** Records that a ready order was handed to the broker. */
export async function markOrderSubmitted(
  tx: Transaction,
  intentId: string,
  brokerOrderId: string,
): Promise<void> {
  const row = await lockOrder(tx, intentId);
  // A broker update can arrive before the submit call returns; it already moved the order on.
  if (row.state !== 'ready') {
    await tx.update(brokerOrders).set({ brokerOrderId }).where(eq(brokerOrders.intentId, intentId));
    return;
  }
  const to = transitionOrder(row.state, 'submitted');
  await tx
    .update(brokerOrders)
    .set({ state: to, brokerOrderId, submittedAt: new Date() })
    .where(eq(brokerOrders.intentId, intentId));
  await tx.insert(orderEvents).values({
    userId: row.userId,
    intentId,
    source: 'app',
    fromState: row.state,
    toState: to,
    payload: { kind: 'submitted', brokerOrderId },
  });
}

/** Records that submission failed before the broker accepted the order. */
export async function markOrderFailed(
  tx: Transaction,
  intentId: string,
  reason: string,
): Promise<void> {
  const row = await lockOrder(tx, intentId);
  if (isTerminalOrderState(row.state)) return;
  const to = transitionOrder(row.state, 'failed');
  await tx
    .update(brokerOrders)
    .set({ state: to, reason: reason.slice(0, 500), terminalAt: new Date() })
    .where(eq(brokerOrders.intentId, intentId));
  await tx.insert(orderEvents).values({
    userId: row.userId,
    intentId,
    source: 'app',
    fromState: row.state,
    toState: to,
    payload: { kind: 'submit_failed', reason: reason.slice(0, 500) },
  });
}

const BROKER_STATES: readonly OrderState[] = [
  'ready',
  'submitted',
  'acknowledged',
  'partially_filled',
  'filled',
  'canceled',
  'expired',
];

export interface AppliedUpdates {
  state: OrderState;
  /** Updates that were new; repeats of earlier ones are ignored. */
  applied: number;
}

/**
 * Applies broker updates to an order (§8.4, §8.5). Each update is stored once,
 * by its broker event id; the state is then re-derived from every stored update.
 */
export async function applyBrokerUpdates(
  tx: Transaction,
  intentId: string,
  updates: readonly BrokerUpdate[],
  source: 'broker' | 'reconciliation' = 'broker',
): Promise<AppliedUpdates> {
  const row = await lockOrder(tx, intentId);
  const stored = await tx
    .select({ payload: orderEvents.payload })
    .from(orderEvents)
    .where(eq(orderEvents.intentId, intentId))
    .orderBy(asc(orderEvents.seq));
  const known = stored
    .map((e) => e.payload as { kind?: string; update?: BrokerUpdate })
    .filter((p) => p.kind === 'broker_update' && p.update)
    .map((p) => p.update as BrokerUpdate);
  // Orders the app rejected or failed itself never reached a broker.
  if (!BROKER_STATES.includes(row.state) && known.length === 0) {
    throw new OrderError('invalid_state', `An order in state ${row.state} has no broker updates`);
  }
  const seen = new Set(known.map((u) => u.eventId));
  const quantity = new Decimal(row.quantity);

  let state = row.state;
  let applied = 0;
  for (const update of updates) {
    if (seen.has(update.eventId)) continue;
    seen.add(update.eventId);
    known.push(update);
    applied += 1;
    const view = deriveBrokerOrder(quantity, known);
    await tx.insert(orderEvents).values({
      userId: row.userId,
      intentId,
      source,
      fromState: state,
      toState: view.state,
      brokerEventId: update.eventId,
      payload: { kind: 'broker_update', update },
      providerAt: new Date(update.at),
    });
    if (update.kind === 'fill' && update.fill) {
      await tx
        .insert(fills)
        .values({
          userId: row.userId,
          intentId,
          brokerFillId: update.eventId,
          quantity: update.fill.quantity,
          price: update.fill.price,
          fee: update.fill.fee,
          filledAt: new Date(update.at),
        })
        .onConflictDoNothing();
    }
    state = view.state;
  }
  if (applied === 0) return { state, applied };

  const view = deriveBrokerOrder(quantity, known);
  const date = (v: string | undefined) => (v === undefined ? null : new Date(v));
  await tx
    .update(brokerOrders)
    .set({
      state: view.state,
      rawStatus: view.rawStatus ?? null,
      filledQuantity: view.filledQuantity.toString(),
      averagePrice: view.averagePrice?.toString() ?? null,
      fees: view.fees.toString(),
      overfilled: view.overfilled,
      reason: view.reason?.slice(0, 500) ?? null,
      acknowledgedAt: date(view.acknowledgedAt),
      filledAt: date(view.filledAt),
      terminalAt: date(view.terminalAt),
    })
    .where(eq(brokerOrders.intentId, intentId));
  return { state: view.state, applied };
}

export interface OrderTimelineEntry {
  source: string;
  fromState: OrderState | null;
  toState: OrderState | null;
  payload: unknown;
  providerAt: Date | null;
  receivedAt: Date;
}

export async function getOrderTimeline(
  tx: Transaction,
  intentId: string,
): Promise<OrderTimelineEntry[]> {
  return tx
    .select({
      source: orderEvents.source,
      fromState: orderEvents.fromState,
      toState: orderEvents.toState,
      payload: orderEvents.payload,
      providerAt: orderEvents.providerAt,
      receivedAt: orderEvents.receivedAt,
    })
    .from(orderEvents)
    .where(eq(orderEvents.intentId, intentId))
    .orderBy(asc(orderEvents.seq));
}
